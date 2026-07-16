// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// Action tests replay the recorded provider fixtures under fixtures/ — CI
// never needs live keys. Re-record with `bun run record-fixtures` after
// changing prompts, props or SDK versions (the replay transport throws on
// request drift).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runClassify } from './actions/classify';
import { runExtractStructuredData, shapeToJsonSchema } from './actions/extract-structured-data';
import { runGenerate } from './actions/generate';
import { runSummarize } from './actions/summarize';
import { asText, withUsageMarker } from './actions/common';
import { clampMaxTokens, DEFAULT_MAX_TOKENS, MAX_OUTPUT_TOKENS_CAP, resolveModel } from './models';
import { AiDeps } from './providers';

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
  response: { status: number; body: Record<string, unknown> };
}

interface Fixture {
  version: 1;
  case: string;
  calls: RecordedCall[];
}

const TEST_ENV = {
  TYRBO_AI_ANTHROPIC_KEY: 'test-anthropic-key',
  TYRBO_AI_OPENAI_KEY: 'test-openai-key',
};

function loadFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'fixtures', `${name}.json`), 'utf-8'),
  ) as Fixture;
}

/**
 * Sequenced replay transport: serves the fixture's recorded responses in
 * order and throws on drift (unexpected extra calls, URL or model mismatch)
 * with a re-record hint — same convention as Farebear/tyrbo
 * packages/ai-builder fixtures.
 */
function replayFetch(fixture: Fixture): typeof globalThis.fetch {
  let next = 0;
  return async (input, init) => {
    const recorded = fixture.calls[next];
    if (!recorded) {
      throw new Error(`replay(${fixture.case}): unexpected call #${next + 1} — re-record fixtures`);
    }
    next += 1;
    const url = input instanceof Request ? input.url : String(input);
    if (url !== recorded.url) {
      throw new Error(`replay(${fixture.case}): URL drift ${url} !== ${recorded.url} — re-record fixtures`);
    }
    const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    const body = typeof rawBody === 'string' ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    if (body['model'] !== recorded.body['model']) {
      throw new Error(
        `replay(${fixture.case}): model drift ${String(body['model'])} !== ${String(recorded.body['model'])} — re-record fixtures`,
      );
    }
    return new Response(JSON.stringify(recorded.response.body), {
      status: recorded.response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function depsFor(fixture: Fixture): AiDeps {
  return { env: TEST_ENV, fetch: replayFetch(fixture) };
}

describe('recorded fixture replay', () => {
  it('extractStructuredData returns schema-shaped JSON under outputVariable + $ai usage', async () => {
    const fixture = loadFixture('anthropic.extract');
    const output = await runExtractStructuredData(
      {
        input: 'INVOICE #2041 — Northwind Traders …',
        shape: {
          vendor: 'the vendor / issuing company name',
          invoiceNumber: 'the invoice number',
          total: 'the total amount due, as a number without currency symbol',
          dueDate: 'the due date in YYYY-MM-DD',
        },
        outputVariable: 'invoice',
        model: 'claude-haiku-4-5',
        maxTokens: 512,
      },
      depsFor(fixture),
    );
    const invoice = output['invoice'] as Record<string, unknown>;
    expect(invoice['vendor']).toBe('Northwind Traders');
    expect(invoice['total']).toBe(129.6);
    const usage = fixture.calls[0].response.body['usage'] as Record<string, number>;
    expect(output['$ai']).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: usage['input_tokens'],
      tokensOut: usage['output_tokens'],
    });
  });

  it('summarize returns text under outputVariable + $ai usage', async () => {
    const fixture = loadFixture('anthropic.summarize');
    const output = await runSummarize(
      {
        input: 'INVOICE #2041 — Northwind Traders …',
        style: 'one short sentence',
        outputVariable: 'summary',
        model: 'claude-haiku-4-5',
        maxTokens: 256,
      },
      depsFor(fixture),
    );
    expect(typeof output['summary']).toBe('string');
    expect((output['summary'] as string).length).toBeGreaterThan(10);
    expect(output['$ai']).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('classify returns one of the allowed labels + $ai usage', async () => {
    const fixture = loadFixture('openai.classify');
    const output = await runClassify(
      {
        input: 'The export button crashes the app whenever I click it on the reports page.',
        labels: ['bug', 'feature-request', 'question'],
        outputVariable: 'category',
        model: 'gpt-5-mini',
        maxTokens: 256,
      },
      depsFor(fixture),
    );
    expect(output['category']).toBe('bug');
    const usage = fixture.calls[0].response.body['usage'] as Record<string, number>;
    expect(output['$ai']).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      tokensIn: usage['prompt_tokens'],
      tokensOut: usage['completion_tokens'],
    });
  });

  it('generate returns text + $ai usage', async () => {
    const fixture = loadFixture('openai.generate');
    const output = await runGenerate(
      {
        instruction:
          'Write a one-sentence friendly reminder that invoice #2041 for $129.60 is due July 31.',
        outputVariable: 'reminder',
        model: 'gpt-5-mini',
        maxTokens: 256,
      },
      depsFor(fixture),
    );
    expect(typeof output['reminder']).toBe('string');
    expect(output['reminder'] as string).toContain('2041');
    expect(output['$ai']).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' });
  });
});

describe('model allowlist', () => {
  it('rejects models that are not on the curated list', () => {
    expect(() => resolveModel('gpt-4o')).toThrow(/not on the Tyrbo model list/);
    expect(() => resolveModel('claude-fable-5')).toThrow(/not on the Tyrbo model list/);
  });

  it('defaults when the prop is missing and resolves allowlisted ids', () => {
    expect(resolveModel(undefined).model).toBe('claude-haiku-4-5');
    expect(resolveModel('claude-sonnet-5').disableThinking).toBe(true);
    expect(resolveModel('gpt-5.1').openaiReasoningEffort).toBe('none');
  });

  it('never reaches a provider for a non-allowlisted model', async () => {
    await expect(
      runGenerate(
        { instruction: 'hi', model: 'gpt-4o' },
        {
          env: TEST_ENV,
          fetch: async () => {
            throw new Error('must not be called');
          },
        },
      ),
    ).rejects.toThrow(/not on the Tyrbo model list/);
  });
});

describe('maxTokens cap', () => {
  it('clamps to the hard cap and floors fractions', () => {
    expect(clampMaxTokens(999_999)).toBe(MAX_OUTPUT_TOKENS_CAP);
    expect(clampMaxTokens(100.9)).toBe(100);
  });

  it('falls back to the default for missing or invalid values', () => {
    expect(clampMaxTokens(undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens('not-a-number')).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens(-5)).toBe(DEFAULT_MAX_TOKENS);
  });

  it('surfaces a truncation error when the model hits the cap', async () => {
    const truncated: Fixture = {
      version: 1,
      case: 'synthetic.truncated',
      calls: [
        {
          url: 'https://api.anthropic.com/v1/messages',
          method: 'POST',
          body: { model: 'claude-haiku-4-5' },
          response: {
            status: 200,
            body: {
              content: [{ type: 'text', text: 'cut off mid-' }],
              stop_reason: 'max_tokens',
              usage: { input_tokens: 10, output_tokens: 64 },
            },
          },
        },
      ],
    };
    await expect(
      runSummarize({ input: 'long text', model: 'claude-haiku-4-5', maxTokens: 64 }, depsFor(truncated)),
    ).rejects.toThrow(/output cap/);
  });
});

describe('Tyrbo-managed keys', () => {
  it('errors clearly when the provider key is not configured (no BYO)', async () => {
    await expect(
      runGenerate({ instruction: 'hi', model: 'claude-haiku-4-5' }, { env: {} }),
    ).rejects.toThrow(/TYRBO_AI_ANTHROPIC_KEY is not configured/);
    await expect(
      runGenerate({ instruction: 'hi', model: 'gpt-5-mini' }, { env: {} }),
    ).rejects.toThrow(/TYRBO_AI_OPENAI_KEY is not configured/);
  });
});

describe('shapeToJsonSchema', () => {
  it('converts a field → description map', () => {
    expect(shapeToJsonSchema({ vendor: 'company name', total: 'amount due' })).toEqual({
      properties: {
        vendor: { description: 'company name' },
        total: { description: 'amount due' },
      },
      required: ['vendor', 'total'],
      additionalProperties: false,
    });
  });

  it('passes a real JSON Schema through', () => {
    const schema = {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
    };
    expect(shapeToJsonSchema(schema)).toEqual({
      properties: { total: { type: 'number' } },
      required: ['total'],
    });
  });

  it('treats a field literally named "type" as a field map', () => {
    const converted = shapeToJsonSchema({ type: 'the document type' });
    expect(converted['properties']).toEqual({ type: { description: 'the document type' } });
  });
});

describe('classify guardrails', () => {
  it('requires at least two labels', async () => {
    await expect(
      runClassify({ input: 'x', labels: ['only-one'], model: 'gpt-5-mini' }, { env: TEST_ENV }),
    ).rejects.toThrow(/at least two labels/);
  });

  it('rejects an off-list answer from the model', async () => {
    const offList: Fixture = {
      version: 1,
      case: 'synthetic.off-list',
      calls: [
        {
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          body: { model: 'gpt-5-mini' },
          response: {
            status: 200,
            body: {
              choices: [
                { message: { content: '{"label":"other"}' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            },
          },
        },
      ],
    };
    await expect(
      runClassify({ input: 'x', labels: ['a', 'b'], model: 'gpt-5-mini' }, depsFor(offList)),
    ).rejects.toThrow(/outside the allowed labels/);
  });
});

describe('fileUrl document intake', () => {
  const SAMPLE_PDF = readFileSync(join(__dirname, '..', '..', 'fixtures', 'sample.pdf'));
  const SAMPLE_PDF_B64 = SAMPLE_PDF.toString('base64');
  const FILE_URL = 'https://files.test/run-inputs/org/auto/upload/mbl-4711.pdf?token=signed';

  /**
   * Routing transport: serves the fixture PDF for the signed file URL and a
   * canned provider response for everything else, capturing the provider
   * request bodies so tests can assert the emitted document blocks.
   */
  function documentDeps(providerBody: Record<string, unknown>): {
    deps: AiDeps;
    providerRequests: Record<string, unknown>[];
  } {
    const providerRequests: Record<string, unknown>[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://files.test/')) {
        return new Response(SAMPLE_PDF, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(SAMPLE_PDF.byteLength),
          },
        });
      }
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      providerRequests.push(JSON.parse(String(rawBody)) as Record<string, unknown>);
      return new Response(JSON.stringify(providerBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { deps: { env: TEST_ENV, fetch: fetchImpl }, providerRequests };
  }

  it('extractStructuredData sends an Anthropic document block; input becomes extra instructions', async () => {
    const { deps, providerRequests } = documentDeps({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_doc_1',
          name: 'extraction',
          input: { vendor: 'Northwind Traders', total: 129.6 },
        },
      ],
      stop_reason: 'tool_use',
      // document pages inflate tokensIn; the marker must carry it unchanged
      usage: { input_tokens: 3894, output_tokens: 58 },
    });
    const output = await runExtractStructuredData(
      {
        fileUrl: FILE_URL,
        input: 'Prefer the header fields over line items.',
        shape: { vendor: 'the vendor name', total: 'total due as a number' },
        outputVariable: 'invoice',
        model: 'claude-haiku-4-5',
        maxTokens: 512,
      },
      deps,
    );

    expect(providerRequests).toHaveLength(1);
    const messages = providerRequests[0]['messages'] as { content: unknown }[];
    expect(messages[0].content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: SAMPLE_PDF_B64 },
      },
      { type: 'text', text: 'Prefer the header fields over line items.' },
    ]);
    expect((output['invoice'] as Record<string, unknown>)['vendor']).toBe('Northwind Traders');
    expect(output['$ai']).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 3894,
      tokensOut: 58,
    });
  });

  it('summarize sends an OpenAI file part; fileUrl alone uses the default instruction', async () => {
    const { deps, providerRequests } = documentDeps({
      choices: [
        { message: { content: 'Master bill MBL-4711 for 3 crates, Rotterdam.' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 4123, completion_tokens: 41 },
    });
    const output = await runSummarize({ fileUrl: FILE_URL, model: 'gpt-5-mini', maxTokens: 256 }, deps);

    const messages = providerRequests[0]['messages'] as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === 'user');
    expect(user?.content).toEqual([
      {
        type: 'file',
        file: {
          filename: 'mbl-4711.pdf',
          file_data: `data:application/pdf;base64,${SAMPLE_PDF_B64}`,
        },
      },
      { type: 'text', text: 'Summarize the attached document.' },
    ]);
    expect(output['summary']).toBe('Master bill MBL-4711 for 3 crates, Rotterdam.');
    expect(output['$ai']).toMatchObject({ tokensIn: 4123, tokensOut: 41 });
  });

  it('accepts the whole upload descriptor ({{trigger.body.<file>}}) and reads .url', async () => {
    const { deps, providerRequests } = documentDeps({
      content: [{ type: 'text', text: 'One-line summary.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2951, output_tokens: 12 },
    });
    const output = await runSummarize(
      {
        fileUrl: { url: FILE_URL, name: 'mbl-4711.pdf', mime: 'application/pdf', size: SAMPLE_PDF.byteLength },
        model: 'claude-haiku-4-5',
      },
      deps,
    );
    const messages = providerRequests[0]['messages'] as { content: { type: string }[] }[];
    expect(messages[0].content[0].type).toBe('document');
    expect(output['summary']).toBe('One-line summary.');
  });

  it('fileUrl guards reject before any provider call', async () => {
    const { deps, providerRequests } = documentDeps({});
    await expect(
      runSummarize({ fileUrl: 'http://files.test/doc.pdf', model: 'claude-haiku-4-5' }, deps),
    ).rejects.toThrow(/must be an https URL/);
    await expect(
      runExtractStructuredData({ fileUrl: 12345, shape: { a: 'b' }, model: 'claude-haiku-4-5' }, deps),
    ).rejects.toThrow(/"fileUrl" must be an https URL string/);
    expect(providerRequests).toEqual([]);
  });

  it('requires input text or a fileUrl document', async () => {
    const { deps, providerRequests } = documentDeps({});
    await expect(runSummarize({ model: 'claude-haiku-4-5' }, deps)).rejects.toThrow(
      /provide "input" text or a "fileUrl" document/,
    );
    await expect(runExtractStructuredData({ shape: { a: 'b' } }, deps)).rejects.toThrow(
      /provide "input" text or a "fileUrl" document/,
    );
    expect(providerRequests).toEqual([]);
  });

  it('text-only steps still send plain string content (no document block)', async () => {
    const { deps, providerRequests } = documentDeps({
      choices: [{ message: { content: 'Short.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 21, completion_tokens: 3 },
    });
    await runSummarize({ input: 'A short text to summarize.', model: 'gpt-5-mini' }, deps);
    const messages = providerRequests[0]['messages'] as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === 'user');
    expect(user?.content).toBe('A short text to summarize.');
  });
});

describe('output shaping', () => {
  it('uses action default keys when outputVariable is missing', () => {
    const output = withUsageMarker(undefined, 'data', { a: 1 }, resolveModel('claude-haiku-4-5'), {
      tokensIn: 1,
      tokensOut: 2,
    });
    expect(output['data']).toEqual({ a: 1 });
    expect(output['$ai']).toMatchObject({ tokensIn: 1, tokensOut: 2 });
  });

  it('the $ai marker survives an outputVariable collision', () => {
    const output = withUsageMarker('$ai', 'data', 'value', resolveModel('claude-haiku-4-5'), {
      tokensIn: 3,
      tokensOut: 4,
    });
    expect(output['$ai']).toMatchObject({ provider: 'anthropic', tokensIn: 3, tokensOut: 4 });
  });

  it('asText coerces objects and rejects empty input', () => {
    expect(asText({ rows: [1, 2] }, 'input')).toContain('"rows"');
    expect(() => asText('   ', 'input')).toThrow(/"input" is required/);
    expect(() => asText(undefined, 'input')).toThrow(/"input" is required/);
  });
});
