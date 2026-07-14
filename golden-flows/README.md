# Golden-flow smoke suite

<!-- TYRBO-PATCH -->

Ten golden flows (webhook trigger, schedule, loop, router branches, code
steps, failure path, concurrency) run through the real engine images via
docker compose. The suite authenticates through the tyrbo auth bridge and
asserts the run-completion webhook fires — it exercises every M1 patch.

**This suite gates every upstream merge** (`tyrbo-golden-flows.yml` runs it
on pull requests and on pushes to `tyrbo`).

## Run locally

```bash
docker build -t tyrbo-engine-api:golden -f Dockerfile .
docker build -t tyrbo-engine-worker:golden -f Dockerfile.worker .

node golden-flows/run.mjs --prepare       # keys + worker token -> .env.golden
docker compose -f golden-flows/docker-compose.golden.yml --env-file golden-flows/.env.golden up -d
node golden-flows/run.mjs                 # the suite
docker compose -f golden-flows/docker-compose.golden.yml --env-file golden-flows/.env.golden down -v
```

Requires internet egress: the engine syncs piece metadata from the official
registry and installs piece packages from npm on first execution.
