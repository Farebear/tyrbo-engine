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
| 3 | planned | Auth bridge: accept Tyrbo-minted JWTs; map `org_id → project` |
| 4 | planned | Run-completion webhook → Tyrbo product API (credit debits + run mirror) |
| 5 | planned | Register `@tyrbo/piece-browser` + `device-routing` queue tag for local execution (session S9) |
| 6 | done | Disable telemetry/phone-home — posthog hard-off in `helper/telemetry.utils.ts` (+ billing capture no-op), template-usage posts removed, `TELEMETRY_ENABLED` flag pinned false for the web UI |

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
git checkout tyrbo && git merge main
# resolve conflicts ONLY in TYRBO-PATCH-tagged regions; everything else takes upstream
# then: run the golden-flow suite (tyrbo repo → engine smoke tests) before pushing
git push origin tyrbo
```

If a merge touches a patch, update the table above in the same PR.
