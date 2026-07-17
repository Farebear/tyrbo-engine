# Tyrbo engine on Fly — staging runbook

TYRBO-PATCH. Provisioning + deploy for the staging environment. Re-provisioned
from scratch on 2026-07-14 after the Upstash cost incident (see guardrails).
Images come from the `tyrbo-release.yml` workflow (GHCR, tagged by commit SHA
plus a moving `tyrbo` branch tag). Staging deploys pin the SHA tag.

Apps (org `tyrbo`, region `iad`) — one `shared-cpu-1x` machine each, no HA spares:

| App | Config | Image | Size |
|---|---|---|---|
| `tyrbo-engine-api-staging` | `fly.api.staging.toml` | `ghcr.io/farebear/tyrbo-engine-api` | shared-cpu-**2x**, 1GB + 512MB swap |
| `tyrbo-engine-worker-staging` | `fly.worker.staging.toml` | `ghcr.io/farebear/tyrbo-engine-worker` | shared-cpu-1x, 1GB + 512MB swap |
| `tyrbo-engine-db-staging` | `fly.db.staging.toml` | `pgvector/pgvector:pg16` | shared-cpu-1x, 512MB, 3GB volume `pgdata` |
| `tyrbo-engine-redis-staging` | `fly.redis.staging.toml` | `redis:7` | shared-cpu-1x, 256MB, 1GB volume `redis_data` |

Sizing notes (all measured 2026-07-14, don't shrink without re-measuring):
512MB is NOT enough for either node app — the API thrashes during piece sync
(health checks time out, the proxy 503s everything and auto-stops the
machine) and the worker's engine sandboxes die with ping timeouts. 1GB is the
memory floor for both. The API also starves on shared-cpu-**1x**: its steady
load exceeds the 1/16-vCPU baseline, burst credits drain within ~10–20 min of
engine activity (top shows ~80% CPU steal) and the proxy pulls it out of
rotation until restarted — 2x is the CPU floor. `AP_LOG_LEVEL=warn` and
`AP_WORKER_CONCURRENCY=4` keep steady CPU down. Postgres at 256MB survives
but the kernel OOM-kills individual backends under flow-publish bursts
("Connection terminated unexpectedly" 500s) — 512MB is its floor. Redis is
fine at 256MB.

Known limitation: under a sustained burst (the full golden suite is the
harshest client staging ever sees) the API can still go briefly deaf while
shared-CPU burst credits recover — a laptop suite run may flake 2–3 flows.
Every flow shape was validated individually against staging on 2026-07-14;
the authoritative full-pass gate is `tyrbo-golden-flows.yml` in CI.

## Cost guardrails (read before touching infra)

On 2026-07-14 a pay-as-you-go Upstash Redis plus BullMQ's idle delayed-job
polling produced a **~$360 overnight bill** and staging had to be rebuilt from
scratch. The rules that keep that from recurring:

- **Zero per-request-billed services.** Redis is a self-hosted `redis:7` Fly
  machine (flat ~$2/mo + volume). Never `fly redis create` (Upstash-backed,
  pay-as-you-go) — BullMQ polls Redis even when completely idle. An Upstash
  **fixed plan** (flat monthly, eviction off) is a sanctioned alternative if
  self-hosting ever grates — the only hard rule is flat billing; swapping is
  one `fly secrets set AP_REDIS_URL` away.
- **Plain-image Postgres, not managed.** Fly's postgres-flex images also lack
  pgvector, which the TyrboBaseline migration requires — `fly postgres create`
  does not work for this engine anyway.
- **Single machine per app.** Always deploy with `--ha=false`; never add HA
  spares or extra regions to staging.
- **Flat monthly cost:** ≈ $19/mo with everything running 24/7
  (api shared-cpu-2x/1GB ≈ $7.8, worker 1x/1GB ≈ $5.7, db 1x/512MB ≈ $3.2,
  redis 1x/256MB ≈ $1.9, volumes 4GB ≈ $0.60), ≈ $5.7/mo scaled to zero
  (db + redis machines + volumes only). Every component is flat-priced —
  nothing in this stack can produce a usage-proportional bill.
- **Billing alerts are manual:** set usage/billing notifications in the Fly
  dashboard (Organization → Billing) — there is no flyctl command for it.

## Scale to zero when staging is idle

The api/worker pair is stateless — flows, connections and runs live in
Postgres/Redis, which stay up. Park staging when nobody is using it:

```sh
fly scale count 0 -a tyrbo-engine-worker-staging
fly scale count 0 -a tyrbo-engine-api-staging
```

Resume:

```sh
fly scale count 1 -a tyrbo-engine-api-staging
fly scale count 1 -a tyrbo-engine-worker-staging   # after the api is healthy
```

The api also parks itself: `auto_stop_machines = "stop"` with
`min_machines_running = 0` lets the proxy stop it once the worker (its only
steady traffic source) is scaled down; the next inbound request restarts it.
The worker has no inbound services and must be scaled manually. Do **not**
scale db/redis to zero — deleting their machines is fine only if you keep the
volumes, but a plain `fly scale count 0` on a volume app leaves the volume
billed anyway (~$0.60/mo total, not worth automating).

## One-time provisioning (from scratch)

Secrets values live in the tyrbo product repo's gitignored `.env.staging`
(registry: tyrbo repo `docs/SECRETS.md`). Generation recipes are in the
Secrets section below.

```sh
for app in tyrbo-engine-db-staging tyrbo-engine-redis-staging \
           tyrbo-engine-api-staging tyrbo-engine-worker-staging; do
  fly apps create "$app" --org tyrbo
done

fly volumes create pgdata     -a tyrbo-engine-db-staging    -r iad -s 3 -y
fly volumes create redis_data -a tyrbo-engine-redis-staging -r iad -s 1 -y

fly secrets set -a tyrbo-engine-db-staging    POSTGRES_PASSWORD=...   # = AP_POSTGRES_PASSWORD
fly secrets set -a tyrbo-engine-redis-staging REDIS_PASSWORD=...      # embedded in AP_REDIS_URL
fly secrets set -a tyrbo-engine-api-staging \
  AP_ENCRYPTION_KEY=... AP_JWT_SECRET=... \
  AP_POSTGRES_HOST=tyrbo-engine-db-staging.internal AP_POSTGRES_PORT=5432 \
  AP_POSTGRES_DATABASE=tyrbo AP_POSTGRES_USERNAME=tyrbo AP_POSTGRES_PASSWORD=... \
  AP_REDIS_URL='redis://default:<REDIS_PASSWORD>@tyrbo-engine-redis-staging.internal:6379?family=6' \
  AP_TYRBO_JWT_PUBLIC_KEY="$(cat public.pem)" AP_TYRBO_WEBHOOK_SECRET=...
fly secrets set -a tyrbo-engine-worker-staging AP_WORKER_TOKEN=...

# data tier first, then api (runs TyrboBaseline migrations on boot), then worker
fly deploy -c tyrbo-deploy/fly.db.staging.toml    --ha=false
fly deploy -c tyrbo-deploy/fly.redis.staging.toml --ha=false
SHA=$(git rev-parse HEAD)   # any full-SHA tag published by tyrbo-release.yml
fly deploy -c tyrbo-deploy/fly.api.staging.toml    --image ghcr.io/farebear/tyrbo-engine-api:$SHA    --ha=false
fly deploy -c tyrbo-deploy/fly.worker.staging.toml --image ghcr.io/farebear/tyrbo-engine-worker:$SHA --ha=false
```

Gotchas baked into the configs, kept here for the next rebuild:

- `AP_FLOW_TIMEOUT_SECONDS = "2100"` on the **api** app (workers receive it
  via the worker-settings response — setting it on the worker app is a
  no-op). It must exceed the browser piece's wait budget: browser-worker
  `RUN_TIMEOUT_MS` (30 min) + `TYRBO_BROWSER_QUEUE_WAIT_MS` (2 min) = 1920 s.
  Keep ≥ 2100 if the fleet's run cap ever grows.

- Fly private networking (6PN) is **IPv6-only** — ioredis needs `?family=6`
  on any `.internal` Redis URL or it hangs resolving AAAA-only hosts.
- The Postgres volume mounts at `/var/lib/postgresql/data` but `PGDATA` must
  point at a subdirectory (`.../data/pgdata`): the volume root contains
  `lost+found` and initdb refuses a non-empty directory.
- GHCR packages must be public (or mirrored to registry.fly.io) for Fly to
  pull them.
- `AP_FRONTEND_URL` must be resolvable by the worker too — the public
  `https://…fly.dev` URL, not `.internal`.

## Secrets

Generate once (never commit; registry: tyrbo repo `docs/SECRETS.md`):

```sh
openssl rand -hex 16   # AP_ENCRYPTION_KEY
openssl rand -hex 16   # AP_JWT_SECRET
openssl rand -hex 16   # REDIS_PASSWORD
openssl rand -hex 24   # AP_TYRBO_WEBHOOK_SECRET / AP_POSTGRES_PASSWORD
```

RSA keypair for the auth bridge (public half → engine `AP_TYRBO_JWT_PUBLIC_KEY`,
private half → Tyrbo product API on Vercel, S5 mints auth-bridge JWTs):
`node golden-flows/run.mjs --prepare` shows the exact shape, or generate with
`generateKeyPairSync('rsa', { modulusLength: 2048 })` as in that script.

`AP_WORKER_TOKEN` is an HS256 JWT signed with `AP_JWT_SECRET`:
payload `{ id: 'staging-worker', type: 'WORKER', iss: 'activepieces', iat, exp }`
(golden-flows/run.mjs `--prepare` shows the exact shape).

`AP_TYRBO_API_URL` (run-completion webhook target) stays **unset** until the
product API ships its receiver (S5/M2b); the webhook path is gated in CI by the
golden-flow suite meanwhile. When setting it, include `AP_SSRF_ALLOW_LIST`
(IPs/CIDRs) if the target is not public.

## Verify

```sh
curl -fsS https://tyrbo-engine-api-staging.fly.dev/api/v1/health
# auth bridge: garbage tokens must return 401 (never 500):
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://tyrbo-engine-api-staging.fly.dev/api/v1/tyrbo/auth/exchange \
  -H 'Content-Type: application/json' -d '{"token":"garbage"}'

# golden suite against staging — write the staging private key first so the
# suite can mint auth-bridge JWTs (base64 PEM lives in tyrbo .env.staging):
printf %s "$TYRBO_ENGINE_JWT_PRIVATE_KEY_PEM_BASE64" | openssl base64 -d -A \
  > golden-flows/.golden-private-key.pem
BASE_URL=https://tyrbo-engine-api-staging.fly.dev/api/v1 node golden-flows/run.mjs
```

Expected against staging: **9/10 on a quiet system** — flow 10 (run-completion
webhook sink) needs the engine to reach a sink on your machine and fails from
a laptop; it's covered in CI by `tyrbo-golden-flows.yml`. See the known
limitation above: a busy API can flake 2–3 more flows; re-run or verify the
failing shape individually before suspecting a regression.

> **Always clean up after a staging suite run.** The suite leaves its flows
> ENABLED and `golden-schedule` fires every minute, burning worker cycles
> forever:
>
> ```sh
> BASE_URL=https://tyrbo-engine-api-staging.fly.dev/api/v1 node golden-flows/cleanup.mjs
> ```

Worker health: `fly logs -a tyrbo-engine-worker-staging` should show
"Polling worker started" ×concurrency and no auth errors.
