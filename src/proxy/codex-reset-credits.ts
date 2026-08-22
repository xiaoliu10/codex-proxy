/**
 * Rate-limit reset credits API.
 *
 * OpenAI added the ability to consume a banked "rate-limit reset credit" to
 * reset a Codex account's eligible rate-limit windows (typically the current
 * weekly + 5-hour windows for Plus/Pro). These functions talk to the same
 * /backend-api base used by /wham/usage.
 *
 * Wire contract (cross-verified against openai/codex PRs #28143/#28793/#30395
 * and the router-for-me/CLIProxyAPI implementation):
 *   GET  /wham/usage                          -> rate_limit_reset_credits.available_count
 *   GET  /wham/rate-limit-reset-credits       -> { credits[], available_count }
 *   POST /wham/rate-limit-reset-credits/consume -> { code, windows_reset }
 *
 * Notes:
 * - Only one POST URL is attempted. No path fallback / auto-retry: a single
 *   user click must never produce two consume calls against the backend.
 * - Unknown outcome codes are surfaced verbatim; the caller decides whether
 *   to treat them as success. Never assume success for an unrecognized code.
 */

import { getConfig } from "../config.js";
import { getTransport, type TlsTransport } from "../tls/transport.js";
import {
  CodexApiError,
  type CodexConsumeResetCreditRequest,
  type CodexConsumeResetCreditResponse,
  type CodexRateLimitResetCredit,
  type CodexRateLimitResetCreditsResponse,
} from "./codex-types.js";

/** Normalize a base URL and append the /wham/... path for reset-credit endpoints. */
function resetCreditsUrl(baseUrl: string, suffix: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // The production ChatGPT base already ends with /backend-api. If a caller
  // passes a bare host, normalize to the backend-api path so reset endpoints
  // resolve like /wham/usage does.
  const base = trimmed.includes("/backend-api")
    ? trimmed
    : `${trimmed.replace(/\/api\/codex$/, "")}/backend-api`;
  return `${base}${suffix}`;
}

function applyAcceptHeaders(headers: Record<string, string>, transport: TlsTransport): void {
  headers["Accept"] = "application/json";
  if (!transport.isImpersonate()) {
    headers["Accept-Encoding"] = "gzip, deflate";
  }
}

/**
 * Fetch the list of banked reset credits.
 *
 * The backend may truncate the credits[] list, so `available_count` is the
 * authoritative total — callers must not replace it with `credits.length`.
 */
export async function fetchResetCredits(
  headers: Record<string, string>,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<CodexRateLimitResetCreditsResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();
  const url = resetCreditsUrl(resolvedBaseUrl, "/wham/rate-limit-reset-credits");

  applyAcceptHeaders(headers, transport);

  let result: { status: number; body: string };
  try {
    result = await transport.get(url, headers, 15, proxyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CodexApiError(0, `transport GET failed for reset credits: ${msg}`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new CodexApiError(result.status, result.body);
  }

  return parseResetCreditsResponse(result.body);
}

function parseResetCreditsResponse(body: string): CodexRateLimitResetCreditsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CodexApiError(502, `Reset credits response is not valid JSON: ${body.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CodexApiError(502, `Reset credits response is not an object: ${body.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;
  const availableCount = parseAvailableCount(obj.available_count, body);

  const rawCredits = Array.isArray(obj.credits) ? obj.credits : [];
  const credits: CodexRateLimitResetCredit[] = [];
  for (const item of rawCredits) {
    const credit = normalizeCredit(item);
    if (credit) credits.push(credit);
  }

  return { credits, available_count: availableCount };
}

function parseAvailableCount(value: unknown, body: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  // The dedicated endpoint should always report available_count; if it is
  // missing/invalid this is not a usable response.
  throw new CodexApiError(502, `Reset credits response has no valid available_count: ${body.slice(0, 200)}`);
}

function normalizeCredit(item: unknown): CodexRateLimitResetCredit | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null; // credits without an id cannot be consumed explicitly
  const str = (key: string): string | null | undefined => {
    const v = obj[key];
    return typeof v === "string" ? v : v == null ? v : undefined;
  };
  return {
    id,
    reset_type: str("reset_type"),
    status: str("status"),
    granted_at: str("granted_at"),
    expires_at: str("expires_at"),
    title: str("title"),
    description: str("description"),
  };
}

/**
 * Consume one reset credit.
 *
 * POST is attempted exactly once against the canonical endpoint. On network
 * failure, timeout, 5xx or an unrecognized outcome the thrown CodexApiError
 * lets the caller decide whether to retry with the SAME idempotency key.
 */
export async function consumeResetCredit(
  headers: Record<string, string>,
  request: CodexConsumeResetCreditRequest,
  proxyUrl?: string | null,
  baseUrl?: string,
  injectedTransport?: TlsTransport,
): Promise<CodexConsumeResetCreditResponse> {
  const resolvedBaseUrl = baseUrl ?? getConfig().api.base_url;
  const transport = injectedTransport ?? getTransport();
  const url = resetCreditsUrl(resolvedBaseUrl, "/wham/rate-limit-reset-credits/consume");

  headers["Content-Type"] = "application/json";
  applyAcceptHeaders(headers, transport);

  const body = JSON.stringify(buildConsumeBody(request));

  let result: { status: number; body: string };
  try {
    result = await transport.simplePost(url, headers, body, 20, proxyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // POST already left the client; the caller must retry with the same idempotency key.
    throw new CodexApiError(0, `transport POST failed for consume reset credit: ${msg}`);
  }

  if (result.status < 200 || result.status >= 300) {
    throw new CodexApiError(result.status, result.body);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    // 2xx but unparseable body → outcome unknown, caller retries same key.
    throw new CodexApiError(0, `Consume response is not valid JSON: ${result.body.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CodexApiError(0, `Consume response is not an object: ${result.body.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.code !== "string" || obj.code.length === 0) {
    // Forward-compatible: surface the raw payload so the caller can inspect it.
    throw new CodexApiError(0, `Consume response has no recognizable code: ${result.body.slice(0, 200)}`);
  }

  const windowsReset =
    typeof obj.windows_reset === "number" && Number.isFinite(obj.windows_reset)
      ? Math.trunc(obj.windows_reset)
      : 0;
  const credit = (obj.credit && typeof obj.credit === "object")
    ? obj.credit as { id?: string }
    : null;

  return {
    code: obj.code,
    windows_reset: windowsReset,
    credit: credit ?? null,
  };
}

function buildConsumeBody(request: CodexConsumeResetCreditRequest): Record<string, string> {
  const body: Record<string, string> = { redeem_request_id: request.redeem_request_id };
  if (typeof request.credit_id === "string" && request.credit_id.length > 0) {
    body.credit_id = request.credit_id;
  }
  return body;
}

/**
 * Select the credit to consume: prefer the soonest-expiring available credit
 * so banked resets are not lost to expiry. Returns null when no available
 * credit carries a usable id (caller then omits credit_id and lets the backend
 * choose, only valid when available_count > 0).
 */
export function selectEarliestAvailableCredit(
  credits: CodexRateLimitResetCredit[],
): CodexRateLimitResetCredit | null {
  const available = credits.filter((c) => isAvailable(c) && typeof c.id === "string" && c.id.length > 0);
  if (available.length === 0) return null;
  available.sort((a, b) => compareExpiry(a.expires_at, b.expires_at));
  return available[0];
}

function isAvailable(credit: CodexRateLimitResetCredit): boolean {
  const status = credit.status?.trim().toLowerCase();
  return !status || status === "available";
}

function compareExpiry(a: string | null | undefined, b: string | null | undefined): number {
  const ta = expiryTime(a);
  const tb = expiryTime(b);
  // Credits without a parseable expiry sort last so expiring ones are redeemed first.
  if (ta == null && tb == null) return 0;
  if (ta == null) return 1;
  if (tb == null) return -1;
  return ta - tb;
}

function expiryTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
