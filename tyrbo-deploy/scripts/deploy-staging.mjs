#!/usr/bin/env node
// TYRBO-PATCH: deploy the staging engine apps to the image pinned in their
// fly.*.staging.toml. Driven by the Tyrbo Deploy Staging workflow when a repin
// commit lands on `tyrbo`, and runnable by hand for a manual deploy/rollback.
//
// The committed `[build] image` line is the single source of truth: whatever
// SHA is pinned there is what gets deployed. API is deployed BEFORE the worker
// (the api boots the engine's own TypeORM migrations against
// tyrbo-engine-db-staging) and each `fly deploy` blocks on health checks, so a
// failed api deploy aborts before the worker is touched.
//
// Local use: FLYCTL_BIN=fly node tyrbo-deploy/scripts/deploy-staging.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePinnedImage } from './image-pin.mjs'

const FLYCTL = process.env.FLYCTL_BIN ?? 'flyctl'
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// order matters: api first (runs migrations on boot), then worker
const APPS = [
    { app: 'tyrbo-engine-api-staging', toml: 'tyrbo-deploy/fly.api.staging.toml' },
    { app: 'tyrbo-engine-worker-staging', toml: 'tyrbo-deploy/fly.worker.staging.toml' },
]

for (const { app, toml } of APPS) {
    const tomlPath = `${REPO_ROOT}/${toml}`
    const { ref } = parsePinnedImage(readFileSync(tomlPath, 'utf8'))
    console.log(`==> Deploying ${app} to ${ref}`)
    execFileSync(FLYCTL, ['deploy', '--config', tomlPath, '--image', ref, '--ha=false'], {
        stdio: 'inherit',
    })
}

console.log('==> Staging engine deploy complete')
