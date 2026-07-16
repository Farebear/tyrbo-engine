// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// fileUrl document intake (M11 file-intake contract 3, Farebear/tyrbo
// docs/FILE-INTAKE.md): actions accept a signed https URL — the run-input
// descriptor's `.url` from the Run-now dialog or email ingress — and the
// engine child fetches the bytes under hard guards, handing the provider a
// native document block so scanned PDFs work without an OCR service.
// Guards: https-only, ≤20 MB, 30 s wall-clock for connect + download.
// TYRBO_AI_INSECURE_FILE_HOSTS (comma-separated hostnames, e.g.
// `host.docker.internal`) exempts stub file servers from https-only — same
// seam family as TYRBO_AI_*_BASE_URL, for tests/e2e only; never set in
// production.

import { AiDeps } from './providers';

export async function fetchDocument({
  fileUrl,
  deps,
  timeoutMs = DOCUMENT_TIMEOUT_MS,
}: {
  fileUrl: string;
  deps?: AiDeps;
  /** Test seam — production callers always take the 30 s default. */
  timeoutMs?: number;
}): Promise<DocumentInput> {
  const url = parseDocumentUrl({ fileUrl, deps });
  const fetchImpl = deps?.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
    });
    assertFinalUrlAllowed({ response, deps });
    if (!response.ok) {
      throw new Error(
        `@tyrbo/piece-ai: fetching "fileUrl" failed with HTTP ${response.status} — the signed URL may have expired`,
      );
    }
    const bytes = await readBodyCapped({ response });
    if (!hasPdfMagic(bytes)) {
      const contentType = response.headers.get('content-type') ?? 'unknown';
      throw new Error(
        `@tyrbo/piece-ai: "fileUrl" did not return a PDF (content-type ${contentType}) — only PDF documents are supported`,
      );
    }
    return {
      data: Buffer.from(bytes).toString('base64'),
      mediaType: 'application/pdf',
      filename: filenameOf(url),
    };
  }
  catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `@tyrbo/piece-ai: fetching "fileUrl" timed out after ${timeoutMs / 1000}s`,
      );
    }
    if (error instanceof Error && error.message.startsWith('@tyrbo/piece-ai')) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`@tyrbo/piece-ai: fetching "fileUrl" failed (${detail})`);
  }
  finally {
    clearTimeout(timer);
  }
}

function parseDocumentUrl({ fileUrl, deps }: { fileUrl: string; deps?: AiDeps }): URL {
  let url: URL;
  try {
    url = new URL(fileUrl);
  }
  catch {
    throw new Error(`@tyrbo/piece-ai: "fileUrl" is not a valid URL (${fileUrl.slice(0, 120)})`);
  }
  assertProtocolAllowed({ url, deps });
  return url;
}

function assertProtocolAllowed({ url, deps }: { url: URL; deps?: AiDeps }): void {
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && insecureFileHosts(deps).has(url.hostname.toLowerCase())) {
    return;
  }
  throw new Error(
    `@tyrbo/piece-ai: "fileUrl" must be an https URL (got ${url.protocol}//${url.host})`,
  );
}

/**
 * A redirect may land the download off https even when the original URL
 * passed the protocol guard — re-check where the response actually came
 * from. Stubbed transports construct a Response without a url; skip those.
 */
function assertFinalUrlAllowed({ response, deps }: { response: Response; deps?: AiDeps }): void {
  if (response.url.length === 0) {
    return;
  }
  assertProtocolAllowed({ url: new URL(response.url), deps });
}

function insecureFileHosts(deps?: AiDeps): Set<string> {
  const raw = (deps?.env ?? process.env)['TYRBO_AI_INSECURE_FILE_HOSTS'] ?? '';
  return new Set(
    raw
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );
}

/**
 * Reads the body while enforcing the size cap: a lying/absent content-length
 * cannot smuggle an oversized file past the guard, and the download aborts
 * as soon as the cap is crossed instead of buffering the rest.
 */
async function readBodyCapped({ response }: { response: Response }): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    throw sizeError();
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw sizeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sizeError(): Error {
  return new Error(
    `@tyrbo/piece-ai: the "fileUrl" document exceeds the ${MAX_DOCUMENT_MB} MB limit`,
  );
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function hasPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

function filenameOf(url: URL): string {
  const last = url.pathname.split('/').filter((part) => part.length > 0).pop() ?? '';
  try {
    const decoded = decodeURIComponent(last);
    return decoded.length > 0 ? decoded : 'document.pdf';
  }
  catch {
    return last.length > 0 ? last : 'document.pdf';
  }
}

/** Mirrors the run-inputs bucket per-file cap (M11 contract 2). */
export const MAX_DOCUMENT_MB = 20;
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;
/** Wall-clock budget for connect + download of the whole document. */
export const DOCUMENT_TIMEOUT_MS = 30_000;

/** Fetched document ready to become a provider-native block (PDF only). */
export interface DocumentInput {
  /** Base64-encoded file bytes. */
  data: string;
  mediaType: 'application/pdf';
  filename: string;
}
