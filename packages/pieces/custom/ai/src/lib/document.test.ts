// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// fileUrl intake guards (M11 file-intake contract 3): https-only, ≤20 MB,
// 30 s timeout, PDF-only. All transports are stubbed — no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchDocument, MAX_DOCUMENT_BYTES } from './document';

const SAMPLE_PDF = readFileSync(join(__dirname, '..', '..', 'fixtures', 'sample.pdf'));

function pdfResponse(): Response {
  return new Response(SAMPLE_PDF, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(SAMPLE_PDF.byteLength),
    },
  });
}

/** Serves `respond()` for every request and counts calls. */
function fetchServing(respond: () => Response): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return respond();
  };
  return { fetch: fetchImpl, calls };
}

describe('fetchDocument happy path', () => {
  it('downloads a PDF and returns base64 + filename from the URL path', async () => {
    const { fetch } = fetchServing(pdfResponse);
    const document = await fetchDocument({
      fileUrl: 'https://files.test/run-inputs/org/auto/upload/mbl-4711.pdf?token=signed',
      deps: { fetch },
    });
    expect(document.mediaType).toBe('application/pdf');
    expect(document.filename).toBe('mbl-4711.pdf');
    expect(Buffer.from(document.data, 'base64').equals(SAMPLE_PDF)).toBe(true);
  });

  it('defaults the filename when the path has none', async () => {
    const { fetch } = fetchServing(pdfResponse);
    const document = await fetchDocument({ fileUrl: 'https://files.test/', deps: { fetch } });
    expect(document.filename).toBe('document.pdf');
  });
});

describe('https-only guard', () => {
  it('rejects http URLs without touching the network', async () => {
    const { fetch, calls } = fetchServing(pdfResponse);
    await expect(
      fetchDocument({ fileUrl: 'http://files.test/doc.pdf', deps: { fetch } }),
    ).rejects.toThrow(/must be an https URL/);
    expect(calls).toEqual([]);
  });

  it('rejects non-http(s) schemes and unparseable URLs', async () => {
    const { fetch } = fetchServing(pdfResponse);
    await expect(
      fetchDocument({ fileUrl: 'file:///etc/passwd', deps: { fetch } }),
    ).rejects.toThrow(/must be an https URL/);
    await expect(
      fetchDocument({ fileUrl: 'not a url at all', deps: { fetch } }),
    ).rejects.toThrow(/not a valid URL/);
  });

  it('TYRBO_AI_INSECURE_FILE_HOSTS exempts listed stub hosts only', async () => {
    const env = { TYRBO_AI_INSECURE_FILE_HOSTS: ' host.docker.internal , stub.local ' };
    const { fetch } = fetchServing(pdfResponse);
    const document = await fetchDocument({
      fileUrl: 'http://host.docker.internal:4177/sample.pdf',
      deps: { fetch, env },
    });
    expect(document.filename).toBe('sample.pdf');
    await expect(
      fetchDocument({ fileUrl: 'http://evil.local/sample.pdf', deps: { fetch, env } }),
    ).rejects.toThrow(/must be an https URL/);
  });

  it('rejects a redirect that lands the download off https', async () => {
    const { fetch } = fetchServing(() => {
      const response = pdfResponse();
      Object.defineProperty(response, 'url', { value: 'http://internal.host/doc.pdf' });
      return response;
    });
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/doc.pdf', deps: { fetch } }),
    ).rejects.toThrow(/must be an https URL/);
  });
});

describe('size guard (20 MB)', () => {
  it('rejects via content-length before reading the body', async () => {
    const { fetch } = fetchServing(
      () =>
        new Response(SAMPLE_PDF, {
          status: 200,
          headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) },
        }),
    );
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/huge.pdf', deps: { fetch } }),
    ).rejects.toThrow(/exceeds the 20 MB limit/);
  });

  it('rejects an oversized streamed body with no content-length', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    chunk.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // starts like a real PDF
    const { fetch } = fetchServing(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(chunk);
              stream.enqueue(chunk);
              stream.enqueue(chunk);
              stream.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/huge.pdf', deps: { fetch } }),
    ).rejects.toThrow(/exceeds the 20 MB limit/);
  });
});

describe('timeout guard', () => {
  it('aborts a stalled download and reports a timeout', async () => {
    const fetchImpl: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const startedAt = Date.now();
    await expect(
      fetchDocument({
        fileUrl: 'https://files.test/slow.pdf',
        deps: { fetch: fetchImpl },
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('content guards', () => {
  it('rejects non-PDF payloads, naming the content-type', async () => {
    const { fetch } = fetchServing(
      () =>
        new Response('<html>expired token page</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/doc.pdf', deps: { fetch } }),
    ).rejects.toThrow(/did not return a PDF \(content-type text\/html\)/);
  });

  it('rejects an empty body', async () => {
    const { fetch } = fetchServing(() => new Response(null, { status: 200 }));
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/doc.pdf', deps: { fetch } }),
    ).rejects.toThrow(/did not return a PDF/);
  });

  it('surfaces HTTP errors with the expired-signed-URL hint', async () => {
    const { fetch } = fetchServing(() => new Response('denied', { status: 403 }));
    await expect(
      fetchDocument({ fileUrl: 'https://files.test/doc.pdf', deps: { fetch } }),
    ).rejects.toThrow(/HTTP 403 — the signed URL may have expired/);
  });
});
