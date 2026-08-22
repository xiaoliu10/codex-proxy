import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("AccountList quota refresh", () => {
  it("delegates per-account quota refresh to the hook, not an inline fetch", () => {
    // Quota refresh now lives in useAccounts().refreshAccountQuota; AccountList
    // only forwards the prop. The inline fetch was removed to centralize it.
    const listSource = readFileSync(
      resolve(__dirname, "../../../web/src/components/AccountList.tsx"),
      "utf-8",
    );
    expect(listSource).not.toContain("`/auth/accounts/${encoded}/quota`");

    const hookSource = readFileSync(
      resolve(__dirname, "../../../shared/hooks/use-accounts.ts"),
      "utf-8",
    );
    expect(hookSource).toContain("`/auth/accounts/${encoded}/quota`");
  });

  it("does not request bulk fresh quota from the account list hook", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../shared/hooks/use-accounts.ts"),
      "utf-8",
    );

    expect(source).toContain("\"/auth/accounts?quota=true\"");
    expect(source).not.toContain("quota=fresh");
  });

  it("keeps the 30s list poll on cached quota only", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../shared/hooks/use-accounts.ts"),
      "utf-8",
    );
    // Polling must only call loadAccounts (GET /auth/accounts), never the
    // per-account reset-credits details endpoint.
    expect(source).toContain("30_000");
    expect(source).toContain("/reset-credits");
    // The reset-credits fetch must be inside named callbacks, not the poll effect.
    const pollBlock = source.slice(
      source.indexOf("Auto-poll cached quota"),
      source.indexOf("Listen for OAuth callback"),
    );
    expect(pollBlock).not.toContain("/reset-credits");
  });
});

