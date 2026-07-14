/**
 * Wire-contract tests for rate-limit reset credits.
 *
 * Covers GET /wham/rate-limit-reset-credits and POST
 * /wham/rate-limit-reset-credits/consume against an injected transport,
 * plus the earliest-expiring credit selection rule.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
  })),
}));

import {
  fetchResetCredits,
  consumeResetCredit,
  selectEarliestAvailableCredit,
} from "@src/proxy/codex-reset-credits.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import type { TlsTransport, CodexRateLimitResetCredit } from "@src/proxy/codex-types.js";

function makeTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
  return {
    post: vi.fn(),
    get: vi.fn(),
    simplePost: vi.fn(),
    isImpersonate: vi.fn(() => false),
    ...overrides,
  } as unknown as TlsTransport;
}

describe("fetchResetCredits", () => {
  it("hits /wham/rate-limit-reset-credits on the configured backend-api base", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ available_count: 2, credits: [] }),
    }));
    const transport = makeTransport({ get });

    const resp = await fetchResetCredits({}, null, undefined, transport);

    expect(get).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      expect.objectContaining({ Accept: "application/json" }),
      15,
      null,
    );
    expect(resp.available_count).toBe(2);
    expect(resp.credits).toEqual([]);
  });

  it("preserves credits with stable fields and ignores unknown extra fields", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        available_count: 1,
        credits: [
          {
            id: "RateLimitResetCredit_1",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: "2026-06-17T00:00:00Z",
            expires_at: "2026-07-17T00:00:00Z",
            title: "Full reset (Weekly + 5 hr)",
            description: "Ready",
            extra_future_field: "ignored",
          },
        ],
      }),
    }));
    const transport = makeTransport({ get });

    const resp = await fetchResetCredits({}, null, undefined, transport);

    expect(resp.credits).toHaveLength(1);
    expect(resp.credits[0]).toMatchObject({
      id: "RateLimitResetCredit_1",
      reset_type: "codex_rate_limits",
      status: "available",
      expires_at: "2026-07-17T00:00:00Z",
    });
  });

  it("rejects credits without an id (cannot be explicitly consumed)", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        available_count: 2,
        credits: [{ status: "available" }, { id: "good" }],
      }),
    }));
    const transport = makeTransport({ get });

    const resp = await fetchResetCredits({}, null, undefined, transport);
    expect(resp.credits.map((c) => c.id)).toEqual(["good"]);
  });

  it("throws CodexApiError on non-2xx, preserving status/body", async () => {
    const get = vi.fn(async () => ({ status: 401, body: '{"error":"unauthorized"}' }));
    const transport = makeTransport({ get });

    await expect(fetchResetCredits({}, null, undefined, transport)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("throws on missing/invalid available_count (count is authoritative, not credits.length)", async () => {
    const get = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ credits: [{ id: "a" }, { id: "b" }] }),
    }));
    const transport = makeTransport({ get });

    await expect(fetchResetCredits({}, null, undefined, transport)).rejects.toBeInstanceOf(CodexApiError);
  });

  it("throws on non-JSON body", async () => {
    const get = vi.fn(async () => ({ status: 200, body: "<html>nope</html>" }));
    const transport = makeTransport({ get });

    await expect(fetchResetCredits({}, null, undefined, transport)).rejects.toBeInstanceOf(CodexApiError);
  });
});

describe("consumeResetCredit", () => {
  it("POSTs to /consume exactly once with the idempotency body", async () => {
    const simplePost = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ code: "reset", windows_reset: 2 }),
    }));
    const transport = makeTransport({ simplePost });

    const resp = await consumeResetCredit(
      {},
      { redeem_request_id: "8ae96ff3-3425-4f4c-8772-b6fd61502868" },
      null,
      undefined,
      transport,
    );

    expect(simplePost).toHaveBeenCalledTimes(1);
    const [url, , body] = simplePost.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    const parsed = JSON.parse(body as string);
    expect(parsed).toEqual({ redeem_request_id: "8ae96ff3-3425-4f4c-8772-b6fd61502868" });
    expect(resp.code).toBe("reset");
    expect(resp.windows_reset).toBe(2);
  });

  it("includes credit_id when provided", async () => {
    const simplePost = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ code: "reset", windows_reset: 1 }),
    }));
    const transport = makeTransport({ simplePost });

    await consumeResetCredit(
      {},
      { redeem_request_id: "id-1", credit_id: "RateLimitResetCredit_1" },
      null,
      undefined,
      transport,
    );

    const body = JSON.parse(simplePost.mock.calls[0][2] as string);
    expect(body).toEqual({
      redeem_request_id: "id-1",
      credit_id: "RateLimitResetCredit_1",
    });
  });

  it("maps the four known outcome codes", async () => {
    for (const code of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"]) {
      const simplePost = vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({ code, windows_reset: 0 }),
      }));
      const transport = makeTransport({ simplePost });
      const resp = await consumeResetCredit({}, { redeem_request_id: "id" }, null, undefined, transport);
      expect(resp.code).toBe(code);
    }
  });

  it("surfaces unknown outcome codes verbatim (does not pretend success)", async () => {
    const simplePost = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ code: "some_future_code" }),
    }));
    const transport = makeTransport({ simplePost });

    const resp = await consumeResetCredit({}, { redeem_request_id: "id" }, null, undefined, transport);
    expect(resp.code).toBe("some_future_code");
  });

  it("throws CodexApiError(status 0) on transport failure so caller retries same key", async () => {
    const simplePost = vi.fn(async () => { throw new Error("timeout"); });
    const transport = makeTransport({ simplePost });

    await expect(
      consumeResetCredit({}, { redeem_request_id: "id" }, null, undefined, transport),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("throws CodexApiError(status 0) on 2xx non-JSON (outcome unknown)", async () => {
    const simplePost = vi.fn(async () => ({ status: 200, body: "not json" }));
    const transport = makeTransport({ simplePost });

    await expect(
      consumeResetCredit({}, { redeem_request_id: "id" }, null, undefined, transport),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("does NOT fall back to a second URL or retry automatically", async () => {
    const simplePost = vi.fn(async () => ({ status: 500, body: "boom" }));
    const transport = makeTransport({ simplePost });

    await expect(
      consumeResetCredit({}, { redeem_request_id: "id" }, null, undefined, transport),
    ).rejects.toMatchObject({ status: 500 });
    expect(simplePost).toHaveBeenCalledTimes(1);
  });
});

describe("selectEarliestAvailableCredit", () => {
  const mk = (over: Partial<CodexRateLimitResetCredit> = {}): CodexRateLimitResetCredit => ({
    id: over.id ?? "c",
    status: over.status ?? "available",
    expires_at: over.expires_at ?? null,
  });

  it("prefers the soonest-expiring available credit", () => {
    const credits = [
      mk({ id: "a", expires_at: "2026-07-17T00:00:00Z" }),
      mk({ id: "b", expires_at: "2026-06-17T00:00:00Z" }),
    ];
    expect(selectEarliestAvailableCredit(credits)?.id).toBe("b");
  });

  it("skips non-available credits", () => {
    const credits = [
      mk({ id: "a", status: "redeemed", expires_at: "2026-06-17T00:00:00Z" }),
      mk({ id: "b", status: "available", expires_at: "2026-07-17T00:00:00Z" }),
    ];
    expect(selectEarliestAvailableCredit(credits)?.id).toBe("b");
  });

  it("returns null when no available credit has an id", () => {
    expect(selectEarliestAvailableCredit([mk({ id: "" })])).toBeNull();
    expect(selectEarliestAvailableCredit([])).toBeNull();
  });

  it("treats absent status as available", () => {
    const credits = [mk({ id: "x", status: undefined as unknown as string })];
    expect(selectEarliestAvailableCredit(credits)?.id).toBe("x");
  });
});