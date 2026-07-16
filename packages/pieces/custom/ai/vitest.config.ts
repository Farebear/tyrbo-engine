import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Same convention as packages/server/api/vitest.config.ts: resolve the
      // workspace framework from source so tests never need a prior build.
      '@activepieces/pieces-framework': path.resolve(
        __dirname,
        '../../framework/src/index.ts',
      ),
    },
  },
});
