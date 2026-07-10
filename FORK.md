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
| 1 | planned | Delete `packages/ee/` + add `NOTICE` with MIT attribution |
| 2 | planned | Brand/theme layer on `react-ui` (tokens, logos, links) — one theme module, not scattered edits |
| 3 | planned | Auth bridge: accept Tyrbo-minted JWTs; map `org_id → project` |
| 4 | planned | Run-completion webhook → Tyrbo product API (credit debits + run mirror) |
| 5 | planned | Register `@tyrbo/piece-browser` + `device-routing` queue tag for local execution |
| 6 | planned | Disable telemetry/phone-home |

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
