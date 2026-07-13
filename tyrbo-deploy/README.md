# Tyrbo engine on Fly — staging runbook

TYRBO-PATCH. One-time provisioning + deploy for the M1 staging environment.
Images come from the `tyrbo-release.yml` workflow (GHCR, tagged by commit SHA
plus a moving `tyrbo` branch tag). Staging deploys pin the SHA tag.

Apps (org `tyrbo`, region `iad`):

| App | Config | Image |
|---|---|---|
| `tyrbo-engine-api-staging` | `fly.api.staging.toml` | `ghcr.io/farebear/tyrbo-engine-api` |
| `tyrbo-engine-worker-staging` | `fly.worker.staging.toml` | `ghcr.io/farebear/tyrbo-engine-worker` |
| `tyrbo-engine-pg-staging` | flyctl-managed Postgres (needs pgvector — the TyrboBaseline migration creates the extension) | postgres-flex |
| Upstash Redis `tyrbo-engine-redis-staging` | `fly redis create` (no eviction — BullMQ requirement) | — |

## One-time provisioning

```sh
fly postgres create --name tyrbo-engine-pg-staging --org tyrbo --region iad \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
# capture the printed credentials, then create the engine DB + pgvector:
fly postgres connect -a tyrbo-engine-pg-staging \
  -c "CREATE DATABASE tyrbo;" \
  -c "\c tyrbo" -c "CREATE EXTENSION IF NOT EXISTS vector;"

fly redis create --name tyrbo-engine-redis-staging --org tyrbo --region iad --no-eviction
# capture the printed redis URL

fly apps create tyrbo-engine-api-staging --org tyrbo
fly apps create tyrbo-engine-worker-staging --org tyrbo
```

## Secrets

Generate once (never commit; registry: tyrbo repo `docs/SECRETS.md`):

```sh
node - <<'EOF'
const { generateKeyPairSync, randomBytes, createHmac } = require('node:crypto')
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
// ... write to a local scratch file; public key -> engine secret,
// private key -> Tyrbo product API (Vercel env, S5 mints auth-bridge JWTs)
EOF

openssl rand -hex 16   # AP_ENCRYPTION_KEY
openssl rand -hex 16   # AP_JWT_SECRET
openssl rand -hex 24   # AP_TYRBO_WEBHOOK_SECRET
```

`AP_WORKER_TOKEN` is an HS256 JWT signed with `AP_JWT_SECRET`:
payload `{ id: 'staging-worker', type: 'WORKER', iss: 'activepieces', iat, exp }`
(golden-flows/run.mjs `--prepare` shows the exact shape).

```sh
fly secrets set -a tyrbo-engine-api-staging \
  AP_ENCRYPTION_KEY=... AP_JWT_SECRET=... \
  AP_POSTGRES_HOST=tyrbo-engine-pg-staging.flycast AP_POSTGRES_PORT=5432 \
  AP_POSTGRES_DATABASE=tyrbo AP_POSTGRES_USERNAME=postgres AP_POSTGRES_PASSWORD=... \
  AP_REDIS_URL=redis://... \
  AP_TYRBO_JWT_PUBLIC_KEY="$(cat public.pem)" AP_TYRBO_WEBHOOK_SECRET=...

fly secrets set -a tyrbo-engine-worker-staging AP_WORKER_TOKEN=...
```

`AP_TYRBO_API_URL` (run-completion webhook target) stays **unset** until the
product API ships its receiver (S5/M2b); the webhook path is gated in CI by the
golden-flow suite meanwhile. When setting it, include `AP_SSRF_ALLOW_LIST`
(IPs/CIDRs) if the target is not public.

## Deploy

```sh
SHA=$(git rev-parse --short=8 HEAD)   # or any tag published by tyrbo-release.yml
fly deploy -c tyrbo-deploy/fly.api.staging.toml    --image ghcr.io/farebear/tyrbo-engine-api:$SHA
fly deploy -c tyrbo-deploy/fly.worker.staging.toml --image ghcr.io/farebear/tyrbo-engine-worker:$SHA
```

The API runs DB migrations on boot (TyrboBaseline is a squashed greenfield
baseline — see FORK.md). GHCR packages must be public (or mirrored to
registry.fly.io) for Fly to pull them.

## Verify

```sh
curl -fsS https://tyrbo-engine-api-staging.fly.dev/api/v1/health
# auth bridge (expects 401 without a valid tyrbo JWT, 200 with one):
curl -s -X POST https://tyrbo-engine-api-staging.fly.dev/api/v1/tyrbo/auth/exchange \
  -H 'Content-Type: application/json' -d '{"token":"<tyrbo-jwt>"}'
# golden suite against staging (webhook sink assertions need a reachable
# AP_TYRBO_API_URL; without one, expect the webhook-assertion tests to fail):
BASE_URL=https://tyrbo-engine-api-staging.fly.dev/api/v1 node golden-flows/run.mjs
```

Worker health: `fly logs -a tyrbo-engine-worker-staging` should show it
registered against the API and polling for jobs.
