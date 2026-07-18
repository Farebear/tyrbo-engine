#!/usr/bin/env node
// TYRBO-PATCH: fail loudly when a committed staging pin was never deployed.
//
// For each staging engine app, compare the `[build] image` pinned in its
// fly.*.staging.toml against the image Fly actually reports as deployed
// (`flyctl image show --app <app> --json`). Exit non-zero on any divergence so
// a scheduled CI job turns "committed-but-undeployed pin" — the exact gap that
// left staging on the pre-OAuth image after engine PR #21 — into a red build.
//
// Local use: FLYCTL_BIN=fly node tyrbo-deploy/scripts/check-image-drift.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareImagePin, parseDeployedImages, parsePinnedImage } from './image-pin.mjs'

const FLYCTL = process.env.FLYCTL_BIN ?? 'flyctl'
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const APPS = [
    { app: 'tyrbo-engine-api-staging', toml: 'tyrbo-deploy/fly.api.staging.toml' },
    { app: 'tyrbo-engine-worker-staging', toml: 'tyrbo-deploy/fly.worker.staging.toml' },
]

function deployedImages(app) {
    const raw = execFileSync(FLYCTL, ['image', 'show', '--app', app, '--json'], { encoding: 'utf8' })
    return parseDeployedImages(raw)
}

let drifted = false
for (const { app, toml } of APPS) {
    const committed = parsePinnedImage(readFileSync(`${REPO_ROOT}/${toml}`, 'utf8'))
    const result = compareImagePin({ committed, deployed: deployedImages(app) })
    if (result.drifted) {
        drifted = true
        const detail = result.reason === 'no-deployed-image'
            ? 'no running machine reported an image'
            : `deployed ${result.deployedRefs.join(', ')}`
        console.error(`::error::${app} DRIFT — committed pin ${result.committedRef} but ${detail}. Redeploy: fly deploy -c ${toml} --image ${committed.ref} --ha=false (or run the Tyrbo Deploy Staging workflow).`)
    }
    else {
        console.log(`✔ ${app} in sync — ${result.committedRef}`)
    }
}

process.exit(drifted ? 1 : 0)
