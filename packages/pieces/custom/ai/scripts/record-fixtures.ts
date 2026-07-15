// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// Records provider fixtures for the action tests — run once per prompt/SDK
// change, then tests replay them (CI never needs live keys):
//
//   TYRBO_AI_ANTHROPIC_KEY=… TYRBO_AI_OPENAI_KEY=… bun run record-fixtures
//
// (ANTHROPIC_API_KEY / OPENAI_API_KEY are accepted as fallbacks for local
// convenience.) One cheap call per fixture — haiku/mini-class, ~cents total.
// Fixtures persist ONLY {url, method, body} of the request and
// {status, body} of the response: keys ride headers, which are never
// captured, and a paranoid scrub aborts if a key value ever appears in the
// serialized fixture.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClassify } from '../src/lib/actions/classify';
import { runExtractStructuredData } from '../src/lib/actions/extract-structured-data';
import { runGenerate } from '../src/lib/actions/generate';
import { runSummarize } from '../src/lib/actions/summarize';
import { AiDeps } from '../src/lib/providers';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  response: { status: number; body: unknown };
}

interface Fixture {
  version: 1;
  case: string;
  recordedAt: string;
  calls: RecordedCall[];
}

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures');

function recordingFetch(calls: RecordedCall[]): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? 'POST').toUpperCase();
    const rawBody = init?.body ?? (request ? await request.clone().text() : undefined);
    const body = typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    const response = await fetch(input, init);
    const responseBody = await response.clone().json();
    calls.push({ url, method, body, response: { status: response.status, body: responseBody } });
    return response;
  };
}

const env = {
  TYRBO_AI_ANTHROPIC_KEY: process.env['TYRBO_AI_ANTHROPIC_KEY'] ?? process.env['ANTHROPIC_API_KEY'],
  TYRBO_AI_OPENAI_KEY: process.env['TYRBO_AI_OPENAI_KEY'] ?? process.env['OPENAI_API_KEY'],
};

const INVOICE = [
  'INVOICE #2041 — Northwind Traders',
  'Date: 2026-07-01',
  'Item: 3x Widget Pro @ $40.00',
  'Subtotal: $120.00, Tax: $9.60',
  'Total due: $129.60 by 2026-07-31',
].join('\n');

const CASES: { name: string; run: (deps: AiDeps) => Promise<Record<string, unknown>> }[] = [
  {
    name: 'anthropic.extract',
    run: (deps) =>
      runExtractStructuredData(
        {
          input: INVOICE,
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
        deps,
      ),
  },
  {
    name: 'anthropic.summarize',
    run: (deps) =>
      runSummarize(
        {
          input: INVOICE,
          style: 'one short sentence',
          outputVariable: 'summary',
          model: 'claude-haiku-4-5',
          maxTokens: 256,
        },
        deps,
      ),
  },
  {
    name: 'openai.classify',
    run: (deps) =>
      runClassify(
        {
          input: 'The export button crashes the app whenever I click it on the reports page.',
          labels: ['bug', 'feature-request', 'question'],
          outputVariable: 'category',
          model: 'gpt-5-mini',
          maxTokens: 256,
        },
        deps,
      ),
  },
  {
    name: 'openai.generate',
    run: (deps) =>
      runGenerate(
        {
          instruction: 'Write a one-sentence friendly reminder that invoice #2041 for $129.60 is due July 31.',
          outputVariable: 'reminder',
          model: 'gpt-5-mini',
          maxTokens: 256,
        },
        deps,
      ),
  },
];

function scrubCheck(serialized: string): void {
  for (const secret of Object.values(env)) {
    if (secret && secret.length > 8 && serialized.includes(secret)) {
      throw new Error('ABORT: a provider key leaked into a fixture — nothing was written');
    }
  }
}

async function main(): Promise<void> {
  if (!env.TYRBO_AI_ANTHROPIC_KEY || !env.TYRBO_AI_OPENAI_KEY) {
    console.error(
      'Set TYRBO_AI_ANTHROPIC_KEY and TYRBO_AI_OPENAI_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) to record.',
    );
    process.exit(1);
  }
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const testCase of CASES) {
    const calls: RecordedCall[] = [];
    const output = await testCase.run({ env, fetch: recordingFetch(calls) });
    const fixture: Fixture = {
      version: 1,
      case: testCase.name,
      recordedAt: new Date().toISOString(),
      calls,
    };
    const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
    scrubCheck(serialized);
    const file = join(FIXTURES_DIR, `${testCase.name}.json`);
    writeFileSync(file, serialized);
    const marker = output['$ai'] as Record<string, unknown>;
    console.log(
      `recorded ${testCase.name} → ${file} (model ${String(marker['model'])}, ` +
        `${String(marker['tokensIn'])} in / ${String(marker['tokensOut'])} out)`,
    );
  }
}

void main();
