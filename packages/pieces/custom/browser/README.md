# @tyrbo/piece-browser

Tyrbo's browser-automation piece (fork patch #5, M6). The Tyrbo compiler
lowers each maximal run of adjacent browser steps into ONE `run` action of
this piece so a single Playwright context survives the group.

The action is a queue producer only — no Playwright here:

- `execution: cloud` → BullMQ `browser-runs` on the engine Redis, consumed
  by the Fly Machines fleet (`Farebear/tyrbo` → `apps/browser-worker`).
- `execution: local` → `device:{deviceId}`, consumed by the linked desktop
  app (M7; errors until then).

It waits for the job result, returns scrape outputs as the step output
(downstream templates: `{{step_N.<outputVariable>}}`) plus `$run`
diagnostics (per-step status, healing, artifact URIs), and throws on failed
runs so the flow fails at this step.

The queue contract is mirrored from
`Farebear/tyrbo apps/browser-worker/src/contract.ts` (source of truth) —
bump `JOB_CONTRACT_VERSION` in both places together.

## Loading & build

Private piece, never on the AP cloud registry. `build` produces a
self-contained CJS bundle (`dist/src/index.js`, deps inlined, `--keep-names`
preserves the `Piece` constructor name the module extractor checks) and is
file-loaded with `AP_DEV_PIECES=browser` on **both** api and worker — which
also merges it into `/v1/pieces` metadata in any environment. Both
Dockerfiles build the piece and keep `packages/pieces/custom/browser/dist`.

## Environment (worker process)

Piece code executes in the forked **engine child**, which receives a
whitelisted env — every var below must be listed in
`AP_SANDBOX_PROPAGATED_ENV_VARS` (configured on the **api** app; values are
read from the **worker** app's env/secrets). See the staging tomls / golden
compose for the exact list.

| Var | Purpose |
|-----|---------|
| `AP_REDIS_URL` (or `AP_REDIS_HOST`/`PORT`/`USER`/`PASSWORD`/`DB`/`USE_SSL`) | queue Redis, same settings the engine uses |
| `TYRBO_BROWSER_POOL_APP` + `TYRBO_FLY_API_TOKEN` | optional: wake the scale-to-zero browser-worker Fly app on enqueue (throttled, best-effort) |
| `TYRBO_BROWSER_WARM_SPARES` | extra machines to start beyond queue depth (default 1) |
| `TYRBO_BROWSER_RUN_TIMEOUT_MS` / `TYRBO_BROWSER_QUEUE_WAIT_MS` | wait budget for the job result (defaults 300s + 120s; keep under the engine flow timeout) |
