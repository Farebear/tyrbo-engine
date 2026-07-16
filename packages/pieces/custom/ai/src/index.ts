// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).
//
// Tyrbo's run-time AI piece (M8.5). AI steps are ordinary integration steps
// (piece "@tyrbo/piece-ai") in the authoring schema — the compiler in
// Farebear/tyrbo packages/schema passes them through like any piece step.
// They are explicitly non-deterministic; browser-step replay determinism is
// unaffected. Each action calls a curated-allowlist model with Tyrbo-managed
// keys (no BYO) and writes a `$ai` usage marker into its step output; the
// run-completion webhook aggregates markers per run into the `aiUsage`
// payload field and the product bills `ai_step_debit` credits.
//
// Loading: this piece is private (never on the AP cloud registry). It is
// built self-contained (esbuild bundle, deps inlined) and loaded from the
// image filesystem via AP_DEV_PIECES=browser,ai on api + worker, which also
// merges it into piece metadata/registry responses in any environment.

import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { classify } from './lib/actions/classify';
import { extractStructuredData } from './lib/actions/extract-structured-data';
import { generate } from './lib/actions/generate';
import { summarize } from './lib/actions/summarize';

export const ai = createPiece({
  displayName: 'Tyrbo AI',
  description:
    'Run-time AI steps: extract structured data, classify, summarize or generate text (Tyrbo-metered, charged as AI credits)',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.68.0',
  // Served by the engine web app (tyrbo theme assets).
  logoUrl: '/tyrbo/logo.png',
  categories: [],
  authors: ['tyrbo'],
  actions: [extractStructuredData, classify, summarize, generate],
  triggers: [],
});
