/**
 * Centralized reasoning-effort policy.
 *
 * The proxy accepts reasoning effort from several entry points (OpenAI Chat
 * `reasoning_effort`, Responses `reasoning.effort`, model-name suffix, config
 * default, Ollama `think`). This module is the single source of truth for
 * which values each entry point accepts, and how budget-based providers
 * (Anthropic / Gemini) map an effort to a token budget.
 *
 * `max` is intentionally NOT a model-name suffix: the `-max` segment already
 * denotes a real model tier (e.g. `gpt-5.1-codex-max`). Reusing it to express
 * a reasoning level would be ambiguous, so `max` only travels through explicit
 * request fields / config defaults / Ollama `think`.
 */

/**
 * Efforts accepted via explicit request fields, config defaults, and Ollama
 * `think`. This is the public, client-facing value set.
 */
export const EXPLICIT_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ExplicitReasoningEffort = (typeof EXPLICIT_REASONING_EFFORTS)[number];

/**
 * Efforts recognized as legacy model-name suffixes (e.g. `gpt-5.4-high`).
 * `max` is deliberately excluded so `gpt-*-codex-max` stays a real model ID.
 */
export const LEGACY_EFFORT_SUFFIXES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type LegacyEffortSuffix = (typeof LEGACY_EFFORT_SUFFIXES)[number];

/**
 * Token budgets for budget-based providers (Anthropic `thinking.budget_tokens`,
 * Gemini `thinkingConfig.thinkingBudget`). Only efforts with a known mapping
 * are listed; `max` has no source-verified budget and must not silently fall
 * back to medium.
 */
export const REASONING_EFFORT_BUDGET: Readonly<Record<string, number>> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

export function isExplicitReasoningEffort(
  value: unknown,
): value is ExplicitReasoningEffort {
  return (
    typeof value === "string" &&
    (EXPLICIT_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * Raised when a request carries a reasoning effort that has no provider
 * budget mapping (e.g. `max`, `minimal`, `none`) and would otherwise be sent
 * to an Anthropic / Gemini direct upstream. Direct handlers convert this to a
 * protocol-correct 400 without making an upstream network request.
 */
export class UnsupportedReasoningEffortError extends Error {
  readonly code = "unsupported_reasoning_effort" as const;
  readonly status = 400 as const;

  constructor(public readonly effort: string) {
    super(
      `reasoning effort '${effort}' has no provider budget mapping for this upstream protocol`,
    );
    this.name = "UnsupportedReasoningEffortError";
  }
}

/**
 * Resolve a budget-based provider token budget for an effort. Throws
 * {@link UnsupportedReasoningEffortError} for efforts without a known mapping
 * instead of silently degrading to a medium budget.
 */
export function resolveProviderBudget(effort: string): number {
  const budget = REASONING_EFFORT_BUDGET[effort];
  if (budget === undefined) throw new UnsupportedReasoningEffortError(effort);
  return budget;
}
