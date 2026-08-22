import { describe, it, expect } from "vitest";
import { translateCodexToGeminiRequest } from "@src/translation/codex-request-to-gemini.js";
import { UnsupportedReasoningEffortError } from "@src/reasoning-effort.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function makeBaseRequest(overrides: Partial<CodexResponsesRequest> = {}): CodexResponsesRequest {
  return {
    model: "gemini-2.5-pro",
    input: [],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("translateCodexToGeminiRequest", () => {
  it("maps high reasoning effort to thinkingBudget", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high" },
    });
    const result = translateCodexToGeminiRequest(req);
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 16000 });
  });

  it("throws for max reasoning effort (no provider budget)", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "max" },
    });
    expect(() => translateCodexToGeminiRequest(req)).toThrow(UnsupportedReasoningEffortError);
  });

  it("maps xhigh effort to 32000 thinkingBudget", () => {
    const req = makeBaseRequest({
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "xhigh" },
    });
    const result = translateCodexToGeminiRequest(req);
    expect(result.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 32000 });
  });
});