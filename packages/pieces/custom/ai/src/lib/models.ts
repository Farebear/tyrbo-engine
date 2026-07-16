// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// Curated per-model allowlist — the ONLY models run-time AI steps may call.
// Never free-text model ids: `resolveModel` throws for anything not listed,
// even in hand-crafted flow JSON. Keys are Tyrbo-managed (fly secrets on the
// worker app), never user-visible; there is no bring-your-own-key.
//
// LOCKSTEP: every `model` id here must have a rate in
// Farebear/tyrbo `packages/credits/src/ai-rates.ts` (`AI_MODEL_RATES`), or
// the product bills it at the conservative fallback rate. Update both
// tables together when adding a model or when a provider reprices.

export type AiProvider = 'anthropic' | 'openai';

export interface AiModelSpec {
  provider: AiProvider;
  /** Provider API model id — also the value stored in flow JSON. */
  model: string;
  label: string;
  /**
   * Anthropic models that run adaptive thinking by default: send
   * `thinking: {type: 'disabled'}` so the whole maxTokens budget goes to the
   * answer and step output stays budget-predictable. Models that reject an
   * explicit `thinking` param (pre-4.6 lines) leave this unset.
   */
  disableThinking?: boolean;
  /**
   * OpenAI reasoning models spend "reasoning tokens" inside
   * max_completion_tokens (a 256-token step would silently truncate) — pin
   * the lowest supported effort so the budget goes to the answer.
   * gpt-5 line supports 'minimal'; the 5.1 line added 'none'.
   */
  openaiReasoningEffort?: 'none' | 'minimal';
}

export const AI_MODELS: AiModelSpec[] = [
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fast, cheapest' },
  { provider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5 — highest quality', disableThinking: true },
  { provider: 'openai', model: 'gpt-5-mini', label: 'GPT-5 Mini — fast', openaiReasoningEffort: 'minimal' },
  { provider: 'openai', model: 'gpt-5.1', label: 'GPT-5.1', openaiReasoningEffort: 'none' },
];

export const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Hard per-step output-token cap; the `maxTokens` prop is clamped to it. */
export const MAX_OUTPUT_TOKENS_CAP = 4096;
export const DEFAULT_MAX_TOKENS = 1024;

export function resolveModel(model: unknown): AiModelSpec {
  const id = typeof model === 'string' && model.length > 0 ? model : DEFAULT_MODEL;
  const spec = AI_MODELS.find((entry) => entry.model === id);
  if (!spec) {
    const allowed = AI_MODELS.map((entry) => entry.model).join(', ');
    throw new Error(
      `@tyrbo/piece-ai: model "${id}" is not on the Tyrbo model list (allowed: ${allowed})`,
    );
  }
  return spec;
}

export function clampMaxTokens(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(Math.floor(parsed), MAX_OUTPUT_TOKENS_CAP);
}

/**
 * Usage marker each action writes into its step output under `$ai`. The
 * run-completion webhook (packages/server/api/src/app/tyrbo/) walks step
 * outputs, sums these per step across loop iterations and ships the
 * aggregate as the payload's `aiUsage` field; the product converts it to
 * `ai_step_debit` credits. Same convention as @tyrbo/piece-browser's `$run`:
 * the compiler never generates template references starting with "$".
 */
export const AI_MARKER_KEY = '$ai';

export interface AiStepMarker {
  provider: AiProvider;
  model: string;
  tokensIn: number;
  tokensOut: number;
}
