// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { Property } from '@activepieces/pieces-framework';
import {
  AI_MARKER_KEY,
  AI_MODELS,
  AiModelSpec,
  AiStepMarker,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_OUTPUT_TOKENS_CAP,
} from '../models';
import { AiUsage } from '../providers';

export function modelProp() {
  return Property.StaticDropdown({
    displayName: 'Model',
    description: 'Curated Tyrbo model list (Tyrbo-supplied keys; usage is metered as AI credits)',
    required: false,
    defaultValue: DEFAULT_MODEL,
    options: {
      options: AI_MODELS.map((model) => ({ label: model.label, value: model.model })),
    },
  });
}

export function maxTokensProp() {
  return Property.Number({
    displayName: 'Max output tokens',
    description: `Per-step output cap, 1–${MAX_OUTPUT_TOKENS_CAP} (default ${DEFAULT_MAX_TOKENS}); bounds the step's AI-credit cost`,
    required: false,
    defaultValue: DEFAULT_MAX_TOKENS,
  });
}

export function outputVariableProp() {
  return Property.ShortText({
    displayName: 'Output variable',
    description: 'Name downstream steps use to reference this result',
    required: true,
  });
}

/**
 * Step output: the result under `outputVariable` (or the action's default
 * key) so downstream engine templates resolve as {{step_N.<var>}}, plus the
 * `$ai` usage marker the run-completion webhook aggregates for billing.
 * Marker written last so a colliding variable name can never clobber it.
 */
export function withUsageMarker(
  outputVariable: unknown,
  defaultKey: string,
  value: unknown,
  model: AiModelSpec,
  usage: AiUsage,
): Record<string, unknown> {
  const key =
    typeof outputVariable === 'string' && outputVariable.trim().length > 0
      ? outputVariable.trim()
      : defaultKey;
  const marker: AiStepMarker = {
    provider: model.provider,
    model: model.model,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  };
  return { [key]: value, [AI_MARKER_KEY]: marker };
}

/** Coerce a templated prop value ({{vars}} may resolve to objects) to text. */
export function asText(value: unknown, propName: string): string {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new Error(`@tyrbo/piece-ai: "${propName}" is required`);
    }
    return value;
  }
  if (value === null || value === undefined) {
    throw new Error(`@tyrbo/piece-ai: "${propName}" is required`);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    }
    catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
