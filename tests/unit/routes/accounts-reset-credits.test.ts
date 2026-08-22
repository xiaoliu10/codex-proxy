/**
 * Tests for the reset-credits management API.
 *   GET  /auth/accounts/:id/reset-credits
 *   POST /auth/accounts/:id/reset-credits/consume
 *
 * CodexApi is mocked so the wire layer is exercised in codex-reset-credits.test.ts;
 * here we verify route contract, validation, idempotency, outcome mapping, and
 * the post-consume sync (quota invalidation + usage/details refresh).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: { jwt_token: null, rotation_strategy: "least_used", rate_limit_backoff_seconds: 60 },
    server: { proxy_api_key: null },
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
    quota: { skip_exhausted: true },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "free",
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({ jitter: vi.fn((v: number) => v) }));
vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));
vi.mock("@src/auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

// Mock CodexApi so we can drive getResetCredits/consumeResetCredit/getUsage.
const codexApiMock = vi.hoisted(() => ({
  getResetCredits: vi.fn(),
  consumeResetCredit: vi.fn(),
  getUsage: vi.fn(),
}));
vi.mock("@src/proxy/codex-api.js", () => ({
  CodexApi: vi.fn().mockImplementation(() => ({
    getResetCredits: codexApiMock.getResetCredits,
    consumeResetCredit: codexApiMock.consumeResetCredit,
    getUsage: codexApiMock.getUsage,
  })),
  CodexApiError: class CodexApiError extends Error {
    constructor(public readonly status: number, public readonly body: string) {
      super(`Codex API error (${status}): ${body}`);
    }
  },
}));

import { Hono } from "hono";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";

const mockScheduler = { scheduleOne: vi.fn(), clearOne: vi.fn(), start: vi.fn(), stop: vi.fn() };

const VALID_UUID = "8ae96ff3-3425-4f4c-8772-b6fd61502868";

function usageBody(over: Record<string, unknown> = {}) {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1700000000 },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    rate_limit_reset_credits: { available_count: 1 },
    ...over,
  };
}

describe("reset credits API", () => {
  let pool: AccountPool;
  let app: Hono;
  let id: string;

  beforeEach(() => {
    pool = new AccountPool();
    app = new Hono();
    app.route("/", createAccountRoutes(pool, mockScheduler as never));
    id = pool.addAccount("tokenAAAA1234567890");
    codexApiMock.getResetCredits.mockReset();
    codexApiMock.consumeResetCredit.mockReset();
    codexApiMock.getUsage.mockReset();
  });

  afterEach(() => { pool.destroy(); vi.clearAllMocks(); });

  it("GET details returns available_count and recommended_credit_id", async () => {
    codexApiMock.getResetCredits.mockResolvedValue({
      available_count: 2,
      credits: [
        { id: "c-late", status: "available", expires_at: "2026-07-17T00:00:00Z" },
        { id: "c-soon", status: "available", expires_at: "2026-06-17T00:00:00Z" },
      ],
    });
    const res = await app.request(`/auth/accounts/${id}/reset-credits`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.available_count).toBe(2);
    expect(data.recommended_credit_id).toBe("c-soon");
  });

  it("GET returns 404 for unknown account", async () => {
    const res = await app.request("/auth/accounts/nope/reset-credits");
    expect(res.status).toBe(404);
  });

  it("GET returns 409 when account is disabled", async () => {
    pool.markStatus(id, "disabled");
    const res = await app.request(`/auth/accounts/${id}/reset-credits`);
    expect(res.status).toBe(409);
  });

  it("POST rejects malformed UUID", async () => {
    const res = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST reset outcome returns 200 with success and refreshes usage+details", async () => {
    codexApiMock.getResetCredits
      .mockResolvedValueOnce({ available_count: 1, credits: [{ id: "c1", status: "available", expires_at: "2026-07-01T00:00:00Z" }] }) // pre-select
      .mockResolvedValueOnce({ available_count: 0, credits: [] }); // post-refresh
    codexApiMock.getUsage.mockResolvedValue(usageBody({ rate_limit_reset_credits: { available_count: 0 } }));
    codexApiMock.consumeResetCredit.mockResolvedValue({ code: "reset", windows_reset: 2 });

    const res = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: VALID_UUID }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.code).toBe("reset");
    expect(data.idempotent).toBe(false);
    expect(data.available_count).toBe(0);
    // Both refresh calls happened
    expect(codexApiMock.getUsage).toHaveBeenCalled();
    expect(codexApiMock.getResetCredits).toHaveBeenCalled();
  });

  it("POST already_redeemed is success+idempotent and still invalidates quota", async () => {
    codexApiMock.getResetCredits.mockResolvedValue({ available_count: 0, credits: [] });
    codexApiMock.getUsage.mockResolvedValue(usageBody({ rate_limit_reset_credits: { available_count: 0 } }));
    codexApiMock.consumeResetCredit.mockResolvedValue({ code: "already_redeemed", windows_reset: 0 });

    const res = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: VALID_UUID }),
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.idempotent).toBe(true);
    expect(data.code).toBe("already_redeemed");
  });

  it("POST nothing_to_reset and no_credit return 200 with success=false", async () => {
    for (const code of ["nothing_to_reset", "no_credit"]) {
      codexApiMock.getResetCredits.mockReset();
      codexApiMock.getUsage.mockReset();
      codexApiMock.consumeResetCredit.mockReset();
      codexApiMock.getResetCredits.mockResolvedValue({ available_count: 0, credits: [] });
      codexApiMock.getUsage.mockResolvedValue(usageBody());
      codexApiMock.consumeResetCredit.mockResolvedValue({ code, windows_reset: 0 });

      const res = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redeem_request_id: VALID_UUID }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.success).toBe(false);
      expect(data.code).toBe(code);
    }
  });

  it("POST transport failure surfaces reset_outcome_unknown with the same redeem id", async () => {
    codexApiMock.getResetCredits.mockResolvedValue({ available_count: 1, credits: [] });
    // consume throws → unknown outcome
    const err = new (await import("@src/proxy/codex-api.js")).CodexApiError(0, "timeout");
    codexApiMock.consumeResetCredit.mockRejectedValue(err);

    const res = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: VALID_UUID }),
    });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code).toBe("reset_outcome_unknown");
    expect(data.redeem_request_id).toBe(VALID_UUID);
  });

  it("concurrent consume with a different redeem id returns 409 reset_in_progress", async () => {
    // Block the first consume so the second arrives while it is in-flight.
    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    codexApiMock.getResetCredits.mockResolvedValue({ available_count: 2, credits: [] });
    codexApiMock.getUsage.mockResolvedValue(usageBody());
    codexApiMock.consumeResetCredit.mockImplementationOnce(async () => {
      await firstDone;
      return { code: "reset", windows_reset: 2 };
    });

    const first = app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: VALID_UUID }),
    });
    // Let the first request register its in-flight consume before firing the
    // second. (Two real UI clicks are separated by a render gap; this models
    // that deterministically instead of relying on microtask ordering.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await app.request(`/auth/accounts/${id}/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem_request_id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(second.status).toBe(409);
    const secondData = await second.json();
    expect(secondData.code).toBe("reset_in_progress");
    releaseFirst();
    await first;
  });

  it("same redeem_request_id concurrent calls share the in-flight promise (no double consume)", async () => {
    codexApiMock.getResetCredits.mockResolvedValue({ available_count: 1, credits: [] });
    codexApiMock.getUsage.mockResolvedValue(usageBody());
    codexApiMock.consumeResetCredit.mockResolvedValue({ code: "reset", windows_reset: 2 });

    const [a, b] = await Promise.all([
      app.request(`/auth/accounts/${id}/reset-credits/consume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redeem_request_id: VALID_UUID }),
      }),
      app.request(`/auth/accounts/${id}/reset-credits/consume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redeem_request_id: VALID_UUID }),
      }),
    ]);
    expect((await a.json()).code).toBe("reset");
    expect((await b.json()).code).toBe("reset");
    // Consume reached the backend exactly once.
    expect(codexApiMock.consumeResetCredit).toHaveBeenCalledTimes(1);
  });
});