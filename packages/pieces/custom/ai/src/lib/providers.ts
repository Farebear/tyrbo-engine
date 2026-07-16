// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// Provider transport. Keys come from the engine-child env (whitelisted via
// AP_SANDBOX_PROPAGATED_ENV_VARS, values set as fly secrets on the worker
// app): TYRBO_AI_ANTHROPIC_KEY / TYRBO_AI_OPENAI_KEY. Tyrbo-managed only —
// a missing key is an operator error, never a prompt for user credentials.
// TYRBO_AI_ANTHROPIC_BASE_URL / TYRBO_AI_OPENAI_BASE_URL override the
// endpoints so tests and the e2e compose can point at a recorded/stubbed
// provider; `deps.fetch` injects a transport for fixture record/replay.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AiModelSpec } from './models';

/** Wall-clock budget per provider call; SDK retries (2) happen within it. */
const TIMEOUT_MS = 120_000;

export interface AiDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

export interface AiUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface TextRequest {
  model: AiModelSpec;
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface JsonRequest extends TextRequest {
  schemaName: string;
  schema: Record<string, unknown>;
}

function envOf(deps?: AiDeps): Record<string, string | undefined> {
  return deps?.env ?? process.env;
}

function requireKey(deps: AiDeps | undefined, name: string): string {
  const key = envOf(deps)[name];
  if (!key || key.length === 0) {
    throw new Error(
      `@tyrbo/piece-ai: ${name} is not configured on the engine. AI-step keys are Tyrbo-managed ` +
        '(fly secrets on the worker app + AP_SANDBOX_PROPAGATED_ENV_VARS on the api app); there is no bring-your-own-key.',
    );
  }
  return key;
}

function anthropicClient(deps?: AiDeps): Anthropic {
  return new Anthropic({
    apiKey: requireKey(deps, 'TYRBO_AI_ANTHROPIC_KEY'),
    baseURL: envOf(deps)['TYRBO_AI_ANTHROPIC_BASE_URL'] || undefined,
    timeout: TIMEOUT_MS,
    ...(deps?.fetch ? { fetch: deps.fetch } : {}),
  });
}

function openaiClient(deps?: AiDeps): OpenAI {
  return new OpenAI({
    apiKey: requireKey(deps, 'TYRBO_AI_OPENAI_KEY'),
    baseURL: envOf(deps)['TYRBO_AI_OPENAI_BASE_URL'] || undefined,
    timeout: TIMEOUT_MS,
    ...(deps?.fetch ? { fetch: deps.fetch } : {}),
  });
}

function truncationError(action: string, maxTokens: number): Error {
  return new Error(
    `@tyrbo/piece-ai: the model hit the ${maxTokens}-token output cap before finishing (${action}). ` +
      'Raise the step\'s "Max output tokens" or shorten the input.',
  );
}

function anthropicUsage(usage: Anthropic.Usage): AiUsage {
  return {
    tokensIn:
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    tokensOut: usage.output_tokens,
  };
}

function openaiUsage(usage: OpenAI.CompletionUsage | null | undefined): AiUsage {
  return {
    tokensIn: usage?.prompt_tokens ?? 0,
    tokensOut: usage?.completion_tokens ?? 0,
  };
}

export async function completeText(
  request: TextRequest,
  deps?: AiDeps,
): Promise<{ text: string; usage: AiUsage }> {
  const { model, system, prompt, maxTokens } = request;
  if (model.provider === 'anthropic') {
    const response = await anthropicClient(deps).messages.create({
      model: model.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(model.disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'max_tokens') {
      throw truncationError('text generation', maxTokens);
    }
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { text, usage: anthropicUsage(response.usage) };
  }

  const response = await openaiClient(deps).chat.completions.create({
    model: model.model,
    max_completion_tokens: maxTokens,
    ...(model.openaiReasoningEffort ? { reasoning_effort: model.openaiReasoningEffort } : {}),
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: prompt },
    ],
  });
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('@tyrbo/piece-ai: the provider returned no completion choices');
  }
  if (choice.finish_reason === 'length') {
    throw truncationError('text generation', maxTokens);
  }
  return { text: choice.message.content ?? '', usage: openaiUsage(response.usage) };
}

export async function completeJson(
  request: JsonRequest,
  deps?: AiDeps,
): Promise<{ json: Record<string, unknown>; usage: AiUsage }> {
  const { model, system, prompt, maxTokens, schemaName, schema } = request;
  if (model.provider === 'anthropic') {
    // Forced tool use is the schema-shaped path that works across the
    // allowlist without strict-schema constraints on user-authored shapes.
    const response = await anthropicClient(deps).messages.create({
      model: model.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(model.disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
      tools: [
        {
          name: schemaName,
          description: 'Record the result. Always call this tool.',
          input_schema: { type: 'object' as const, ...schema },
        },
      ],
      tool_choice: { type: 'tool', name: schemaName },
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'max_tokens') {
      throw truncationError('structured output', maxTokens);
    }
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      throw new Error(
        '@tyrbo/piece-ai: the model returned no structured result — it may have declined the request',
      );
    }
    return {
      json: toolUse.input as Record<string, unknown>,
      usage: anthropicUsage(response.usage),
    };
  }

  const response = await openaiClient(deps).chat.completions.create({
    model: model.model,
    max_completion_tokens: maxTokens,
    ...(model.openaiReasoningEffort ? { reasoning_effort: model.openaiReasoningEffort } : {}),
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, schema: { type: 'object', ...schema }, strict: false },
    },
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: prompt },
    ],
  });
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('@tyrbo/piece-ai: the provider returned no completion choices');
  }
  if (choice.finish_reason === 'length') {
    throw truncationError('structured output', maxTokens);
  }
  const raw = choice.message.content ?? '';
  try {
    return {
      json: JSON.parse(raw) as Record<string, unknown>,
      usage: openaiUsage(response.usage),
    };
  }
  catch {
    throw new Error(
      `@tyrbo/piece-ai: the model returned invalid JSON (${raw.slice(0, 120)}…) — try raising "Max output tokens"`,
    );
  }
}
