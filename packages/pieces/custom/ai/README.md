# @tyrbo/piece-ai

Tyrbo's run-time AI piece (fork patch #7, M8.5). AI steps are ordinary
integration steps (`piece: @tyrbo/piece-ai`) in the authoring schema; the
Tyrbo compiler passes them through like any piece step. They are explicitly
non-deterministic — browser-step replay determinism is unaffected.

Actions (matching the `Farebear/tyrbo` AI-builder catalog):

- `extractStructuredData` — input + shape (field → description, or a JSON
  Schema object) → schema-shaped JSON via forced tool use (Anthropic) /
  `json_schema` response format (OpenAI)
- `classify` — pick exactly one of ≥2 labels (enum-constrained)
- `summarize` — optional style hint
- `generate` — free-form text from an instruction

Every action returns `{ [outputVariable]: result, $ai: {provider, model,
tokensIn, tokensOut} }`. Downstream engine templates read
`{{step_N.<outputVariable>}}`; the `$ai` marker is aggregated per run by the
run-completion webhook (`packages/server/api/src/app/tyrbo/tyrbo-ai-usage.ts`)
into the `aiUsage` payload field, which the product converts to
`ai_step_debit` credits (`Farebear/tyrbo packages/credits/src/ai-rates.ts` —
keep the model ids in **lockstep** with `src/lib/models.ts` here).

## Models & guardrails

Curated per-model allowlist only (`src/lib/models.ts`, Anthropic + OpenAI at
launch) — free-text model ids are rejected even in hand-crafted flow JSON.
Per-step `maxTokens` prop is clamped to 1–4096 (default 1024). Keys are
Tyrbo-managed; there is no bring-your-own-key.

## Loading & build

Private piece, never on the AP cloud registry. `build` produces a
self-contained CJS bundle (`dist/src/index.js`, provider SDKs inlined,
`--keep-names` preserves the `Piece` constructor name the module extractor
checks) and is file-loaded with `AP_DEV_PIECES=browser,ai` on **both** api
and worker — which also merges it into `/v1/pieces` metadata in any
environment. Both Dockerfiles build the piece and keep
`packages/pieces/custom/ai/dist`.

## Environment (worker process)

Piece code executes in the forked **engine child**, which receives a
whitelisted env — every var below must be listed in
`AP_SANDBOX_PROPAGATED_ENV_VARS` (configured on the **api** app; values are
read from the **worker** app's env/secrets). See the staging tomls / golden
compose for the exact list.

| Var | Purpose |
|-----|---------|
| `TYRBO_AI_ANTHROPIC_KEY` | Anthropic API key (fly secret on the worker app; Tyrbo-managed, never user-visible) |
| `TYRBO_AI_OPENAI_KEY` | OpenAI API key (same handling) |
| `TYRBO_AI_ANTHROPIC_BASE_URL` / `TYRBO_AI_OPENAI_BASE_URL` | optional endpoint overrides for tests / the stubbed-provider e2e; unset in staging/production |

## Tests

`bun run test` (vitest) replays recorded provider fixtures under
`fixtures/` — CI never needs live keys. To re-record after changing prompts
or SDK versions (one cheap call per fixture, cents):

```bash
TYRBO_AI_ANTHROPIC_KEY=… TYRBO_AI_OPENAI_KEY=… bun run record-fixtures
```
