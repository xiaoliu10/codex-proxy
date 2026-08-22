/**
 * AccountResetCreditService — per-account reset-credit management.
 *
 * Coordinates:
 * - Fetching details via CodexApi.getResetCredits() with a short in-memory TTL.
 * - Selecting the earliest-expiring available credit.
 * - Serialising consume calls with idempotency-key deduplication.
 * - Post-consume quota invalidation and dual-refresh (usage + details).
 */

import type { AccountPool } from "../auth/account-pool.js";
import { CodexApi } from "../proxy/codex-api.js";
import {
  selectEarliestAvailableCredit,
} from "../proxy/codex-reset-credits.js";
import { toQuota } from "../auth/quota-utils.js";
import { clearWarnings } from "../auth/quota-warnings.js";
import { isTokenInvalidError } from "../proxy/error-classification.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type {
  CodexRateLimitResetCredit,
  CodexConsumeResetCreditResponse,
} from "../proxy/codex-types.js";
import type { CodexQuota } from "../auth/types.js";

/** Outcome the caller can act on without inspecting per-code JSON. */
export interface ResetCreditDetails {
  available_count: number;
  credits: CodexRateLimitResetCredit[];
  recommended_credit_id: string | null;
  fetched_at: string;
}

export interface ResetCreditConsumeRequest {
  redeem_request_id: string;
  credit_id?: string;
}

export interface ResetCreditConsumeResult {
  success: boolean;
  code: string;
  idempotent: boolean;
  windows_reset: number;
  redeem_request_id: string;
  credit_id: string | null;
  available_count: number;
  quota: CodexQuota | null;
  refresh: { usage: "ok" | "failed"; reset_credits: "ok" | "failed" };
  quota_verify_required: boolean;
}

const DETAILS_TTL_MS = 30_000;

export class AccountResetCreditService {
  private pool: AccountPool;
  private cookieJar?: CookieJar;
  private proxyPool?: ProxyPool | null;

  /** Cached detail responses keyed by entry ID. */
  private detailsCache = new Map<string, { details: ResetCreditDetails; atMs: number }>();

  /** In-flight consume promises keyed by `${entryId}:${redeem_request_id}`. */
  private consumeInFlight = new Map<string, Promise<ResetCreditConsumeResult>>();

  constructor(
    pool: AccountPool,
    options?: { cookieJar?: CookieJar; proxyPool?: ProxyPool | null },
  ) {
    this.pool = pool;
    this.cookieJar = options?.cookieJar;
    this.proxyPool = options?.proxyPool ?? null;
  }

  /** Validate that the account exists and is in a state that allows a reset operation. */
  validateAccount(id: string): { ok: true; token: string; accountId: string | null; status: string }
    | { ok: false; httpStatus: number; code: string } {
    const entry = this.pool.getEntry(id);
    if (!entry) return { ok: false, httpStatus: 404, code: "account_not_found" };
    if (entry.status === "disabled" || entry.status === "expired" || entry.status === "banned") {
      return { ok: false, httpStatus: 409, code: "account_not_eligible" };
    }
    return { ok: true, token: entry.token, accountId: entry.accountId, status: entry.status };
  }

  /**
   * Get reset-credit details for an account.
   * A short TTL cache prevents double-details on button pre-click re-render.
   */
  async getDetails(id: string): Promise<ResetCreditDetails> {
    const cached = this.detailsCache.get(id);
    if (cached && Date.now() - cached.atMs < DETAILS_TTL_MS) {
      return cached.details;
    }

    const validation = this.validateAccount(id);
    if (!validation.ok) {
      throw Object.assign(new Error(validation.code), { httpStatus: validation.httpStatus });
    }

    const api = new CodexApi(
      validation.token,
      validation.accountId,
      this.cookieJar,
      id,
      this.proxyPool?.resolveProxyUrl(id),
    );

    const fetchedAt = new Date().toISOString();
    let details: ResetCreditDetails;
    try {
      const resp = await api.getResetCredits();
      const recommended = selectEarliestAvailableCredit(resp.credits);
      details = {
        available_count: resp.available_count,
        credits: resp.credits,
        recommended_credit_id: recommended?.id ?? null,
        fetched_at: fetchedAt,
      };
    } catch (err) {
      // If details fail but we have a count from a prior /wham/usage, surface
      // the cached count — the user may still be able to consume without a
      // specific credit_id.
      const entry = this.pool.getEntry(id);
      const fallbackCount = entry?.cachedQuota?.rate_limit_reset_credits?.available_count;
      if (fallbackCount != null && fallbackCount > 0) {
        details = {
          available_count: fallbackCount,
          credits: [],
          recommended_credit_id: null,
          fetched_at: fetchedAt,
        };
      } else {
        // Re-throw so the caller can surface the transient failure.
        throw err;
      }
    }

    // Update the account-level summary so the list pick up the latest count.
    this.pool.updateResetCreditSummary(id, { available_count: details.available_count });
    this.detailsCache.set(id, { details, atMs: Date.now() });
    return details;
  }

  /**
   * Consume one reset credit.
   *
   * Idempotency: same `redeem_request_id` reuses the in-flight promise;
   * a *different* request while another is in-flight returns 409.
   */
  async consume(id: string, request: ResetCreditConsumeRequest): Promise<ResetCreditConsumeResult> {
    const validation = this.validateAccount(id);
    if (!validation.ok) {
      return {
        success: false,
        code: validation.code,
        idempotent: false,
        windows_reset: 0,
        redeem_request_id: request.redeem_request_id,
        credit_id: request.credit_id ?? null,
        available_count: 0,
        quota: null,
        refresh: { usage: "failed", reset_credits: "failed" },
        quota_verify_required: false,
      };
    }

    const flightKey = `${id}:${request.redeem_request_id}`;
    const existing = this.consumeInFlight.get(flightKey);
    if (existing) return existing;

    // Reject concurrent consume with a different idempotency key. This check
    // happens BEFORE any async work so a second click is rejected immediately
    // rather than racing past the in-flight registration below.
    for (const [key] of this.consumeInFlight) {
      if (key.startsWith(`${id}:`)) {
        return makeConflictResult(request);
      }
    }

    const entry = this.pool.getEntry(id);
    const proxyUrl = this.proxyPool?.resolveProxyUrl(id);
    const api = new CodexApi(entry!.token, entry!.accountId, this.cookieJar, id, proxyUrl);

    // Register the in-flight promise FIRST, then do the (async) credit
    // selection inside it. This guarantees same-key callers join the same
    // promise and different-key callers see the conflict above.
    const promise = this.runConsume(id, request, api);
    this.consumeInFlight.set(flightKey, promise);

    try {
      return await promise;
    } finally {
      this.consumeInFlight.delete(flightKey);
    }
  }

  private async runConsume(
    id: string,
    request: ResetCreditConsumeRequest,
    api: CodexApi,
  ): Promise<ResetCreditConsumeResult> {
    // If no credit_id was provided, select the earliest available from details.
    let creditId = request.credit_id;
    if (!creditId) {
      try {
        const details = await this.getDetails(id);
        if (details.credits.length > 0) {
          const recommended = selectEarliestAvailableCredit(details.credits);
          creditId = recommended?.id;
        }
      } catch {
        // Detail failure is not a blocker — consume can succeed without credit_id.
      }
    }
    return this.executeConsume(id, request.redeem_request_id, creditId, api);
  }

  private async executeConsume(
    id: string,
    redeemRequestId: string,
    creditId: string | undefined,
    api: CodexApi,
  ): Promise<ResetCreditConsumeResult> {
    let consumeResp: CodexConsumeResetCreditResponse;
    try {
      consumeResp = await api.consumeResetCredit({
        redeem_request_id: redeemRequestId,
        credit_id: creditId,
      });
    } catch (err) {
      // Transient (network/5xx/unknown pay load) — surface as unknown outcome
      // so the caller retries with the same key.
      if (isTokenInvalidError(err)) {
        this.pool.markStatus(id, "expired");
      }
      // NOTE: do NOT treat 403 as a ban here. The reset-credit endpoint returns
      // 403 for accounts/plans without reset entitlement, which is a healthy
      // account permission issue. We still surface unknown outcome so the
      // caller can retry safely; the GET details path reports the 403
      // explicitly to the user without mutating account status.
      return makeOutcomeUnknown(redeemRequestId, creditId ?? null);
    }

    const code = consumeResp.code;
    const isSuccess = code === "reset" || code === "already_redeemed";
    const idempotent = code === "already_redeemed";

    // Any confirmed business outcome invalidates the stale details cache —
    // it may still recommend a credit that was just consumed. The post-consume
    // refresh repopulates it when the details call succeeds.
    if (code === "reset" || code === "already_redeemed" || code === "no_credit" || code === "nothing_to_reset") {
      this.detailsCache.delete(id);
    }

    if (isSuccess) {
      // Atomic: clear cached locks before we refresh.
      this.pool.invalidateQuotaAfterManualReset(id);
      clearWarnings(id);
    }

    // Always refresh to pick up the new state (windows + count).
    const refresh = await this.refreshAfterConsume(id, api);
    return {
      success: isSuccess,
      code,
      idempotent,
      windows_reset: consumeResp.windows_reset ?? 0,
      redeem_request_id: redeemRequestId,
      credit_id: creditId ?? null,
      available_count: refresh.resetCreditsCount,
      quota: refresh.quota,
      refresh: refresh.outcome,
      quota_verify_required: refresh.quotaVerifyRequired,
    };
  }

  private async refreshAfterConsume(
    id: string,
    api: CodexApi,
  ): Promise<{
    outcome: { usage: "ok" | "failed"; reset_credits: "ok" | "failed" };
    resetCreditsCount: number;
    quota: CodexQuota | null;
    quotaVerifyRequired: boolean;
  }> {
    let usageOutcome: "ok" | "failed" = "failed";
    let detailsOutcome: "ok" | "failed" = "failed";
    let quota: CodexQuota | null = null;
    let count = 0;

    // Parallel: usage + details.
    const [usageResult, detailsResult] = await Promise.allSettled([
      api.getUsage().then((u) => {
        usageOutcome = "ok";
        quota = toQuota(u);
        this.pool.updateCachedQuota(id, quota);
        return quota;
      }),
      api.getResetCredits().then((r) => {
        detailsOutcome = "ok";
        count = r.available_count;
        this.pool.updateResetCreditSummary(id, { available_count: count });
        this.detailsCache.set(id, {
          details: {
            available_count: count,
            credits: r.credits,
            recommended_credit_id: selectEarliestAvailableCredit(r.credits)?.id ?? null,
            fetched_at: new Date().toISOString(),
          },
          atMs: Date.now(),
        });
      }),
    ]);

    // Fallback count from usage summary when details fail.
    if (detailsOutcome === "failed" && usageResult.status === "fulfilled") {
      const rcs = usageResult.value?.rate_limit_reset_credits;
      if (rcs && typeof rcs.available_count === "number") {
        count = rcs.available_count;
      }
    }

    // If usage refresh failed and we successfully reset, the dirty flag
    // remains true so the next proxy request verifies upstream.
    const entry = this.pool.getEntry(id);

    return {
      outcome: { usage: usageOutcome, reset_credits: detailsOutcome },
      resetCreditsCount: count,
      quota,
      quotaVerifyRequired: entry?.quotaVerifyRequired ?? false,
    };
  }
}

function makeOutcomeUnknown(
  redeemRequestId: string,
  creditId: string | null,
): ResetCreditConsumeResult {
  return {
    success: false,
    code: "reset_outcome_unknown",
    idempotent: false,
    windows_reset: 0,
    redeem_request_id: redeemRequestId,
    credit_id: creditId,
    available_count: 0,
    quota: null,
    refresh: { usage: "failed", reset_credits: "failed" },
    quota_verify_required: false,
  };
}

function makeConflictResult(request: ResetCreditConsumeRequest): ResetCreditConsumeResult {
  return {
    success: false,
    code: "reset_in_progress",
    idempotent: false,
    windows_reset: 0,
    redeem_request_id: request.redeem_request_id,
    credit_id: request.credit_id ?? null,
    available_count: 0,
    quota: null,
    refresh: { usage: "failed", reset_credits: "failed" },
    quota_verify_required: false,
  };
}
