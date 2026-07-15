# tyrbo-engine — fork of activepieces/activepieces

This is Tyrbo's integration/orchestration engine. Product code lives in
[Farebear/tyrbo](https://github.com/Farebear/tyrbo) and consumes this repo only as
Docker images + published npm packages. Master plan: `tyrbo` repo → `docs/PLAN.md`.

## Rules

1. **All work happens on the `tyrbo` branch** (the default). `main` tracks upstream and is never committed to directly.
2. **Patch surface stays ≤ ~10 diffs.** Every intentional divergence from upstream is tagged `// TYRBO-PATCH` (or `<!-- TYRBO-PATCH -->`) and listed below. Anything not tagged is fair game to be overwritten by an upstream merge.
3. **Never modify community pieces in place** — add new `@tyrbo/*` pieces instead.
4. **`packages/ee` is deleted and must never return.** It is proprietary (not MIT). CI must grep-fail on any `ee/` import. Keep MIT attribution in `NOTICE`.

## Patch list (M1, session S1 — keep in sync with reality)

| # | Status | Patch |
|---|--------|-------|
| 1 | done | Delete proprietary EE code (`packages/ee/`, `packages/server/api/src/app/ee/`) + `NOTICE` + CI grep-gate (`.github/workflows/tyrbo-ci.yml`). CE call sites now import from `packages/server/api/src/app/tyrbo/ce-defaults.ts` (one MIT stub layer, same symbol names); `app/tyrbo/tyrbo-project-module.ts` serves `/v1/projects` + re-registers the CE worker project controller; migration chain squashed to one generated baseline (`1806100000000-TyrboBaseline.ts`, drift-gated by `check-migrations`) |
| 2 | done | Brand/theme layer: server `app/tyrbo/tyrbo-theme.ts` feeds the default THEME flag (name, logos, primary); web `styles/tyrbo-theme.css` overrides the token blocks (bg `#06070A`, purple primary, brand gradient var); assets in `packages/web/public/tyrbo/`; dark-first default; title/favicon via vite config |
| 3 | done | Auth bridge: `POST /v1/tyrbo/auth/exchange` verifies short-lived RS256 JWTs against `AP_TYRBO_JWT_PUBLIC_KEY` (issuer `AP_TYRBO_JWT_ISSUER`, aud `tyrbo-engine`; claims `sub`/`email`/`org_id`/`org_name`), idempotently provisions identity + user + TEAM project (`externalId = org_id`, platform bootstrapped on first exchange), records org membership in `project.metadata.tyrboMembers`, returns the standard `AuthenticationResponse` |
| 4 | done | Run-completion webhook: on terminal state `flowRunHooks.onFinish` fire-and-forgets a run summary POST to `AP_TYRBO_API_URL` (`Authorization: Bearer AP_TYRBO_WEBHOOK_SECRET`), 5 attempts with exponential backoff via the SSRF-safe client; payload includes `orgId` (= project externalId) for cross-DB-free joins |
| 5 | done (M6, S9) | `@tyrbo/piece-browser` — additive piece at `packages/pieces/custom/browser/` (new files; zero server-code changes). The `run` action enqueues the compiled browser sub-program on BullMQ `browser-runs` (cloud fleet = Farebear/tyrbo `apps/browser-worker`) or `device:{deviceId}` (local; consumer ships with the desktop app, M7), awaits the job result, returns scrape outputs as the step output (+ `$run` diagnostics). Built self-contained (esbuild bundle, deps inlined, `--keep-names` so the `Piece` constructor-name check survives) and file-loaded via `AP_DEV_PIECES=browser` on api + worker — never on the AP cloud registry; the dev-pieces path also merges it into `/v1/pieces` metadata in any environment. Both Dockerfiles build + keep `packages/pieces/custom/browser/dist` (tagged). Optional scale-to-zero pool wake via Fly Machines API (`TYRBO_BROWSER_POOL_APP` env + `TYRBO_FLY_API_TOKEN` secret). Golden suite asserts registry presence; full execution e2e lives in Farebear/tyrbo |
| 6 | done | Disable telemetry/phone-home — posthog hard-off in `helper/telemetry.utils.ts` (+ billing capture no-op), template-usage posts removed, `TELEMETRY_ENABLED` flag pinned false for the web UI |
| 7 | done (M8.5, S12) | `@tyrbo/piece-ai` — additive piece at `packages/pieces/custom/ai/` (same pattern as #5: esbuild self-contained bundle with `--keep-names`, file-loaded via `AP_DEV_PIECES=browser,ai` on api + worker, both Dockerfiles build + keep the dist). Actions `extractStructuredData`/`classify`/`summarize`/`generate` call a **curated model allowlist** (Anthropic + OpenAI; never free-text ids) with Tyrbo-managed keys `TYRBO_AI_ANTHROPIC_KEY`/`TYRBO_AI_OPENAI_KEY` (worker fly secrets, whitelisted into the engine child via the api's `AP_SANDBOX_PROPAGATED_ENV_VARS`; no BYO), per-step `maxTokens` cap, and write a `$ai` usage marker (`{provider, model, tokensIn, tokensOut}`) into the step output. Run-completion webhook (patch #4 file + new `tyrbo-ai-usage.ts`) aggregates markers per step across loop iterations into an additive `aiUsage` payload field for `ai_step_debit` billing (contract: Farebear/tyrbo `packages/credits` `runAiUsageSchema`). Golden suite asserts registry presence; action tests replay recorded provider fixtures (CI never needs live keys); stubbed-provider execution e2e lives in Farebear/tyrbo |

### Patch 1 notes (EE removal)

- The enterprise LICENSE covered exactly `packages/ee/` and `packages/server/api/src/app/ee/`; both are deleted and gated in CI (`ee-gate` job fails on the dirs existing or on any `ee/` import path). `packages/core/shared/src/lib/ee` is MIT-licensed type definitions and stays.
- CE semantics of the stub layer: project access = platform admin or project owner; plans are the static `OPEN_SOURCE_PLAN`; RBAC/members/SSO/OTP/SMTP/secret-managers/git-sync/chat/alerts are inert.
- Migrations: fresh deployments run only `TyrboBaseline`. On upstream merges, drop upstream's new migration imports that touch EE-only tables; append the rest after the baseline; `check-migrations` + the golden-flow suite gate the result.
- `.env.tests` runs `AP_EDITION=ce`; `test-ee`/`test-cloud` targets are gone.

## Upstream merge runbook (monthly)

```bash
git remote add upstream https://github.com/activepieces/activepieces.git  # once
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout tyrbo && git checkout -b upstream-merge-$(date +%Y%m) && git merge main
# resolve conflicts ONLY in TYRBO-PATCH-tagged regions; everything else takes upstream
# then open a PR against tyrbo — the golden-flow suite gates it in CI
```

Merge mechanics specific to this fork:

- **Deleted proprietary trees** (`packages/ee/`, `packages/server/api/src/app/ee/`,
  worker `jobs/ee`, chat-eval, ee/cloud tests): upstream will re-add or modify
  files there — resolve with `git rm -r` on those paths (keep deleted). The
  `ee-gate` CI job catches anything missed.
- **`app.ts` / stub layer**: new EE imports or edition-switch registrations
  take the deleted side; if upstream adds a NEW EE symbol that CE code consumes,
  add a community-default stub to `app/tyrbo/ce-defaults.ts` and swap the import.
- **Migrations** (`postgres-connection.ts`): our `getMigrations()` returns only
  `TyrboBaseline`. Take upstream's new migration files, then append the ones that
  touch community tables after the baseline; drop migrations that only touch
  EE tables. `check-migrations` + the golden-flow suite verify the result.
- **Verification order**: `bun install && npx turbo run build --filter=api
  --filter=worker --filter=web && (cd packages/server/api && bun run test-unit)`,
  then the golden-flow suite (`golden-flows/README.md`) — it runs automatically
  on the merge PR.

If a merge touches a patch, update the table above in the same PR.
