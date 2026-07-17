// TYRBO-PATCH: browser cloud-time e2e (run-ai.mjs style, engine-side).
//
// Verifies the run-completion webhook's `cloudBrowserMs` end to end: flows
// with @tyrbo/piece-browser groups run through the REAL engine images while
// this script plays the browser-worker fleet — stub BullMQ workers on the
// piece's queues (browser-runs + a device queue) returning contract-shaped
// BrowserRunJobResult objects with known durationMs values. Asserts:
//
//   1. a run with cloud browser groups SUCCEEDS and its run summary carries
//      cloudBrowserMs = the SUM of the cloud groups' reported durationMs;
//   2. a local/device-tagged group contributes nothing to cloudBrowserMs;
//   3. a FAILED run (browser group ok, later step throws) still reports the
//      cloud time of the groups that finished — the product side may bill
//      timeouts/partial runs later.
//
// Usage (from the repo root; bullmq resolves from the root install, or run
// `npm install` inside golden-flows/ first):
//
//   node golden-flows/run.mjs --prepare                  # once, if no .env.golden
//   node golden-flows/run-browser.mjs                    # brings compose up/down itself
//   E2E_KEEP_STACK=1 node golden-flows/run-browser.mjs   # reuse/leave the stack
//
// If the golden stack is already up (CI runs this right after run.mjs), the
// script detects it and leaves compose alone.

import { spawn } from 'node:child_process'
import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'bullmq'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = join(HERE, '.env.golden')
const COMPOSE = ['compose', '-f', join(HERE, 'docker-compose.golden.yml'), '--env-file', ENV_FILE]
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080/api/v1'
const SINK_PORT = Number(process.env.SINK_PORT ?? 4747)
// the golden compose exposes its redis on host port 6390 for these stubs
const REDIS = { host: '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6390), maxRetriesPerRequest: null }

const BROWSER_PIECE = '@tyrbo/piece-browser'
const DEVICE_ID = 'golden-device'
const JOB_CONTRACT_VERSION = 1
// What the stub fleet reports per group — the webhook must sum the cloud
// ones and ignore the device one.
const CLOUD_MS = { step_cloud_a: 1234, step_cloud_b: 766, step_cloud_fail: 1500 }
const LOCAL_MS = 999

// ---------------------------------------------------------------------------
// scaffolding (mirrors run.mjs)
// ---------------------------------------------------------------------------

const b64url = (input) => Buffer.from(input).toString('base64url')

function signJwt(payload, pem) {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: '1' }))
    const body = b64url(JSON.stringify(payload))
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${body}`)
    return `${header}.${body}.${signer.sign(pem, 'base64url')}`
}

function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
        child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)))
        child.on('error', reject)
    })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs
    let lastErr = null
    while (Date.now() < deadline) {
        try {
            const value = await fn()
            if (value !== undefined && value !== null && value !== false) {
                return value
            }
        }
        catch (err) {
            lastErr = err
        }
        await sleep(intervalMs)
    }
    throw new Error(`timed out waiting for ${what}${lastErr ? `; last error: ${lastErr.message}` : ''}`)
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`assertion failed: ${message}`)
    }
}

const results = []
async function test(name, fn) {
    const startedAt = Date.now()
    try {
        await fn()
        results.push({ name, ok: true })
        console.log(`  ✓ ${name} (${Date.now() - startedAt}ms)`)
    }
    catch (err) {
        results.push({ name, ok: false, error: err.message })
        console.error(`  ✗ ${name}: ${err.message}`)
    }
}

let token = null
let projectId = null

async function api(method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
    }
    const text = await res.text()
    return text.length > 0 ? JSON.parse(text) : null
}

// ---------------------------------------------------------------------------
// stub browser-worker fleet: contract-shaped results with known durations
// ---------------------------------------------------------------------------

function stubResult(durationMs) {
    const finishedAt = new Date()
    const startedAt = new Date(finishedAt.getTime() - durationMs)
    return {
        v: JOB_CONTRACT_VERSION,
        workerId: 'golden-stub-worker',
        status: 'ok',
        timedOut: false,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        result: {
            status: 'ok',
            steps: [{
                stepId: 's1',
                action: 'goto',
                status: 'ok',
                attempts: 1,
                durationMs,
                healed: false,
                artifacts: [],
            }],
            variables: {},
            outputs: { scraped: 'golden' },
        },
    }
}

function startStubFleet() {
    const consumed = []
    const handler = (fallbackMs) => async (job) => {
        consumed.push({ queue: job.queueName, stepName: job.data.stepName, execution: job.data.input?.execution })
        assert(job.data.v === JOB_CONTRACT_VERSION, `job contract v${JOB_CONTRACT_VERSION} (got v${job.data.v})`)
        return stubResult(CLOUD_MS[job.data.stepName] ?? fallbackMs)
    }
    const workers = [
        new Worker('browser-runs', handler(1), { connection: { ...REDIS } }),
        new Worker(`device.${DEVICE_ID}`, async (job) => {
            consumed.push({ queue: job.queueName, stepName: job.data.stepName, execution: job.data.input?.execution })
            return stubResult(LOCAL_MS)
        }, { connection: { ...REDIS } }),
    ]
    return { workers, consumed }
}

// ---------------------------------------------------------------------------
// flow-building blocks (shapes match the engine's FlowAction schema)
// ---------------------------------------------------------------------------

const errorHandling = { retryOnFailure: { value: false }, continueOnFailure: { value: false } }

let webhookPieceVersion = null
let browserPieceVersion = null

const webhookTrigger = (nextAction) => ({
    name: 'trigger',
    displayName: 'Catch Webhook',
    type: 'PIECE_TRIGGER',
    valid: true,
    settings: {
        pieceName: '@activepieces/piece-webhook',
        pieceVersion: webhookPieceVersion,
        triggerName: 'catch_webhook',
        input: { authType: 'none', authFields: {} },
        propertySettings: {
            authType: { type: 'MANUAL' },
            authFields: { type: 'MANUAL', schema: {} },
            liveMarkdown: { type: 'MANUAL' },
            syncMarkdown: { type: 'MANUAL' },
            testMarkdown: { type: 'MANUAL' },
        },
        sampleData: {},
    },
    ...(nextAction ? { nextAction } : {}),
})

const browserStep = (name, input, nextAction) => ({
    name,
    displayName: `Browser ${name}`,
    type: 'PIECE',
    valid: true,
    skip: false,
    settings: {
        pieceName: BROWSER_PIECE,
        actionName: 'run',
        pieceVersion: browserPieceVersion,
        input: { program: [{ id: 's1', action: 'goto', url: 'https://example.com' }], ...input },
        sampleData: {},
        propertySettings: {
            execution: { type: 'MANUAL' },
            program: { type: 'MANUAL' },
            session: { type: 'MANUAL' },
            deviceId: { type: 'MANUAL' },
        },
        errorHandlingOptions: errorHandling,
    },
    ...(nextAction ? { nextAction } : {}),
})

const codeStep = (name, code, nextAction) => ({
    name,
    displayName: `Code ${name}`,
    type: 'CODE',
    valid: true,
    skip: false,
    settings: {
        input: {},
        sampleData: {},
        sourceCode: { code, packageJson: '{}' },
        errorHandlingOptions: errorHandling,
    },
    ...(nextAction ? { nextAction } : {}),
})

async function createFlow(displayName, trigger) {
    const flow = await api('POST', '/flows', { displayName, projectId })
    await api('POST', `/flows/${flow.id}`, {
        type: 'IMPORT_FLOW',
        request: { displayName, schemaVersion: '17', notes: [], trigger },
    })
    await api('POST', `/flows/${flow.id}`, { type: 'LOCK_AND_PUBLISH', request: {} })
    await api('POST', `/flows/${flow.id}`, { type: 'CHANGE_STATUS', request: { status: 'ENABLED' } })
    await waitFor(`flow ${displayName} ENABLED`, async () => {
        const current = await api('GET', `/flows/${flow.id}`)
        return current.status === 'ENABLED'
    }, { timeoutMs: 45_000 })
    return flow
}

// generous default: the FIRST flow execution provisions piece packages from
// npm inside the engine worker, which can dominate a cold stack's wall clock
async function waitForRun(flowId, statuses, { timeoutMs = 420_000 } = {}) {
    return waitFor(`a ${statuses.join('/')} run of ${flowId}`, async () => {
        const page = await api('GET', `/flow-runs?projectId=${projectId}&flowId=${flowId}&limit=10`)
        return (page.data ?? []).find((r) => statuses.includes(r.status)) ?? false
    }, { timeoutMs, intervalMs: 2000 })
}

// ---------------------------------------------------------------------------
// run-completion webhook sink
// ---------------------------------------------------------------------------

const runSummaries = []

function startSink() {
    const server = createServer((req, res) => {
        let data = ''
        req.on('data', (chunk) => (data += chunk))
        req.on('end', () => {
            try {
                runSummaries.push(JSON.parse(data))
            }
            catch {
                runSummaries.push(null)
            }
            res.writeHead(200).end('ok')
        })
    })
    return new Promise((resolve) => server.listen(SINK_PORT, '0.0.0.0', () => resolve(server)))
}

async function summaryForRun(runId) {
    return waitFor(`run summary for ${runId} at the sink`, () =>
        runSummaries.find((summary) => summary?.runId === runId) ?? false, { timeoutMs: 90_000 })
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

async function main() {
    if (!existsSync(ENV_FILE)) {
        console.log('no .env.golden — running run.mjs --prepare')
        await run('node', [join(HERE, 'run.mjs'), '--prepare'])
    }

    const alreadyUp = await fetch(`${BASE_URL}/flags`).then((res) => res.ok).catch(() => false)
    let broughtUp = false
    if (!alreadyUp) {
        console.log('== starting golden compose ==')
        await run('docker', [...COMPOSE, 'up', '-d'])
        broughtUp = true
    }
    else {
        console.log('golden stack already up — reusing it')
    }

    const sink = await startSink()
    console.log(`run-completion sink listening on :${SINK_PORT}`)
    const fleet = startStubFleet()
    console.log(`stub browser fleet consuming browser-runs + device.${DEVICE_ID} via redis :${REDIS.port}`)

    try {
        await waitFor('engine api', async () => (await fetch(`${BASE_URL}/flags`)).ok, { timeoutMs: 180_000, intervalMs: 3000 })

        const pem = readFileSync(join(HERE, '.golden-private-key.pem'), 'utf8')
        const now = Math.floor(Date.now() / 1000)
        const jwt = signJwt({
            iss: 'tyrbo', aud: 'tyrbo-engine', sub: 'user_golden_1',
            email: 'golden@tyrbo.ai', org_id: 'org_golden_1', org_name: 'Golden Org',
            iat: now, exp: now + 300,
        }, pem)
        const auth = await api('POST', '/tyrbo/auth/exchange', { token: jwt })
        token = auth.token
        projectId = auth.projectId
        console.log(`authenticated via auth bridge; org project ${projectId}`)

        console.log('waiting for pieces ...')
        await waitFor('webhook piece', async () => {
            const pieces = await api('GET', '/pieces?searchQuery=webhook')
            const found = (Array.isArray(pieces) ? pieces : pieces.data ?? []).find((piece) => piece.name === '@activepieces/piece-webhook')
            if (found) {
                webhookPieceVersion = `~${found.version}`
            }
            return Boolean(found)
        }, { timeoutMs: 300_000, intervalMs: 3000 })
        await waitFor('browser piece', async () => {
            const pieces = await api('GET', '/pieces?searchQuery=browser')
            const found = (Array.isArray(pieces) ? pieces : pieces.data ?? []).find((piece) => piece.name === BROWSER_PIECE)
            if (found) {
                browserPieceVersion = `~${found.version}`
            }
            return Boolean(found)
        }, { timeoutMs: 120_000, intervalMs: 3000 })
        console.log(`pieces ready (webhook ${webhookPieceVersion}, browser ${browserPieceVersion})`)

        // -- flow A: cloud + cloud + local groups, run succeeds --------------
        let summaryA = null
        await test('cloud groups are summed into cloudBrowserMs; the local group is not', async () => {
            const flow = await createFlow('golden-browser-cloud', webhookTrigger(
                browserStep('step_cloud_a', { execution: 'cloud' },
                    browserStep('step_cloud_b', { execution: 'cloud' },
                        browserStep('step_local', { execution: 'local', deviceId: DEVICE_ID }))),
            ))
            const res = await fetch(`${BASE_URL}/webhooks/${flow.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert(res.ok, `webhook accepted (${res.status})`)
            const flowRun = await waitForRun(flow.id, ['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT'])
            assert(flowRun.status === 'SUCCEEDED', `run SUCCEEDED (got ${flowRun.status})`)
            summaryA = await summaryForRun(flowRun.id)
            const expected = CLOUD_MS.step_cloud_a + CLOUD_MS.step_cloud_b
            assert(typeof summaryA.cloudBrowserMs === 'number',
                `summary carries a numeric cloudBrowserMs (got ${typeof summaryA.cloudBrowserMs})`)
            assert(summaryA.cloudBrowserMs === expected,
                `cloudBrowserMs is the cloud sum ${expected}, device group (${LOCAL_MS}ms) excluded (got ${summaryA.cloudBrowserMs})`)
        })

        await test('stub fleet consumed 2 cloud jobs + 1 device job', async () => {
            const cloud = fleet.consumed.filter((job) => job.queue === 'browser-runs')
            const device = fleet.consumed.filter((job) => job.queue === `device.${DEVICE_ID}`)
            assert(cloud.length === 2, `2 jobs on browser-runs (got ${cloud.length})`)
            assert(cloud.every((job) => job.execution === 'cloud'), 'cloud jobs tagged execution=cloud')
            assert(device.length === 1, `1 job on the device queue (got ${device.length})`)
            assert(device[0].execution === 'local', 'device job tagged execution=local')
        })

        // -- flow B: cloud group ok, later step throws — FAILED run ----------
        await test('a FAILED run still reports the finished cloud group time', async () => {
            const flow = await createFlow('golden-browser-fail', webhookTrigger(
                browserStep('step_cloud_fail', { execution: 'cloud' },
                    codeStep('step_boom', 'export const code = async () => { throw new Error("golden browser failure"); };')),
            ))
            const res = await fetch(`${BASE_URL}/webhooks/${flow.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })
            assert(res.ok, `webhook accepted (${res.status})`)
            const flowRun = await waitForRun(flow.id, ['SUCCEEDED', 'FAILED', 'INTERNAL_ERROR', 'TIMEOUT'])
            assert(flowRun.status === 'FAILED', `run FAILED (got ${flowRun.status})`)
            const summary = await summaryForRun(flowRun.id)
            assert(summary.status === 'FAILED', `summary status FAILED (got ${summary.status})`)
            assert(summary.cloudBrowserMs === CLOUD_MS.step_cloud_fail,
                `cloudBrowserMs ${CLOUD_MS.step_cloud_fail} on the FAILED run (got ${summary.cloudBrowserMs})`)
        })
    }
    finally {
        console.log('== teardown ==')
        sink.close()
        await Promise.all(fleet.workers.map((worker) => worker.close())).catch(() => undefined)
        if (broughtUp && !process.env.E2E_KEEP_STACK) {
            await run('docker', [...COMPOSE, 'down', '-v']).catch(() => undefined)
        }
    }

    // -- report --------------------------------------------------------------
    const failed = results.filter((r) => !r.ok)
    console.log(`\nbrowser cloud-time e2e: ${results.length - failed.length}/${results.length} passed`)
    if (failed.length > 0 || results.length === 0) {
        for (const f of failed) {
            console.error(`  FAILED: ${f.name}: ${f.error}`)
        }
        process.exit(1)
    }
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err)
    process.exit(1)
})
