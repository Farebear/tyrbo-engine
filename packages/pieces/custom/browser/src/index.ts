// TYRBO-PATCH: @tyrbo/piece-browser (fork patch #5, additive piece).
//
// Tyrbo's browser-automation piece. The compiler in Farebear/tyrbo
// packages/schema lowers each maximal run of adjacent browser steps to ONE
// "run" action of this piece, so a single Playwright context survives the
// group. The action itself only produces/consumes queue jobs — execution
// happens on the browser-worker fleet (cloud) or a linked device (M7).
//
// Loading: this piece is private (never on the AP cloud registry). It is
// built self-contained (esbuild bundle, deps inlined) and loaded from the
// image filesystem via AP_DEV_PIECES=browser on api + worker, which also
// merges it into piece metadata/registry responses in any environment.

import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { run } from './lib/actions/run';

export const browser = createPiece({
  displayName: 'Tyrbo Browser',
  description: 'RPA browser automation: replay recorded clicks, typing and scraping',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.68.0',
  // Served by the engine web app (tyrbo theme assets).
  logoUrl: '/tyrbo/logo.png',
  categories: [],
  authors: ['tyrbo'],
  actions: [run],
  triggers: [],
});
