// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { Property } from '@activepieces/pieces-framework';
import { DocumentInput, fetchDocument, MAX_DOCUMENT_MB } from '../document';
import {
  AI_MARKER_KEY,
  AI_MODELS,
  AiModelSpec,
  AiStepMarker,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_OUTPUT_TOKENS_CAP,
} from '../models';
import { AiDeps, AiUsage } from '../providers';

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

export function fileUrlProp() {
  return Property.ShortText({
    displayName: 'File URL',
    description:
      `Optional document to read: an https URL of a PDF (≤${MAX_DOCUMENT_MB} MB), ` +
      'e.g. {{trigger.body.<file>.url}} from a file input. When set, "Input" becomes optional extra instructions',
    required: false,
  });
}

/**
 * fileUrl intake (M11 file-intake contract 3): `fileUrl` usually arrives as
 * the signed URL string ({{trigger.body.<file>.url}}), but a flow that
 * references the whole upload descriptor ({{trigger.body.<file>}} — the
 * {url, name, mime, size} object from contract 2) resolves to an object;
 * accept both and read `.url`.
 */
export async function resolveDocument({
  fileUrl,
  deps,
}: {
  fileUrl: unknown;
  deps?: AiDeps;
}): Promise<DocumentInput | undefined> {
  if (fileUrl === null || fileUrl === undefined) {
    return undefined;
  }
  if (typeof fileUrl === 'string' && fileUrl.trim().length === 0) {
    return undefined;
  }
  const descriptor = asRecord(fileUrl);
  const fromDescriptor = descriptor === undefined ? undefined : descriptor['url'];
  const url = typeof fromDescriptor === 'string' ? fromDescriptor : fileUrl;
  if (typeof url !== 'string') {
    throw new Error(
      '@tyrbo/piece-ai: "fileUrl" must be an https URL string (or a file-input descriptor with a .url)',
    );
  }
  return fetchDocument({ fileUrl: url, deps });
}

/**
 * The document/input contract: with a document attached, the document is the
 * content and `input` is optional extra instruction text; without one,
 * `input` is the required source text.
 */
export function resolvePrompt({
  document,
  input,
  documentInstruction,
}: {
  document: DocumentInput | undefined;
  input: unknown;
  documentInstruction: string;
}): string {
  if (document === undefined) {
    const text = asOptionalText(input);
    if (text === undefined) {
      throw new Error('@tyrbo/piece-ai: provide "input" text or a "fileUrl" document');
    }
    return text;
  }
  return asOptionalText(input) ?? documentInstruction;
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
  const text = asOptionalText(value);
  if (text === undefined) {
    throw new Error(`@tyrbo/piece-ai: "${propName}" is required`);
  }
  return text;
}

export function asOptionalText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim().length === 0 ? undefined : value;
  }
  if (value === null || value === undefined) {
    return undefined;
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
