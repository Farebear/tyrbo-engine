// TYRBO-PATCH: golden-flow smoke suite.
//
// Runs ~10 golden flows (webhook trigger, schedule, loop, router branches,
// code steps, failure path) against a docker-compose bring-up of the built
// tyrbo-engine images, exercising the tyrbo auth bridge for authentication
// and asserting the run-completion webhook fires. Gates every upstream merge.
//
// Self-contained: node >= 20, no dependencies.
//
//   node run.mjs --prepare   writes .env.golden (RSA keypair, worker token,
//                            encryption key) for docker compose
//   node run.mjs             runs the suite against BASE_URL
//                            (default http://localhost:8080/api/v1)
import { createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_FILE = join(HERE, '.env.golden')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080/api/v1'
const SINK_PORT = Number(process.env.SINK_PORT ?? 4747)
const SCHEDULE_TIMEOUT_MS = 150_000

// ---------------------------------------------------------------------------
// jwt helpers (no deps)
// ---------------------------------------------------------------------------

const b64url = (input) => Buffer.from(input).toString('base64url')

function signJwt({ payload, key, alg }) {
    const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid: '1' }))
    const body = b64url(JSON.stringify(payload))
    const data = `${header}.${body}`
    if (alg === 'HS256') {
        const sig = createHmac('sha256', key).update(data).digest('base64url')
        return `${data}.${sig}`
    }
    const signer = createSign('RSA-SHA256')
    signer.update(data)
    return `${data}.${signer.sign(key, 'base64url')}`
}

// ---------------------------------------------------------------------------
// --prepare: write .env.golden for docker compose
// ---------------------------------------------------------------------------

if (process.argv.includes('--prepare')) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const jwtSecret = randomBytes(16).toString('hex')
    const now = Math.floor(Date.now() / 1000)
    const workerToken = signJwt({
        alg: 'HS256',
        key: jwtSecret,
        payload: { id: 'golden-worker', type: 'WORKER', iss: 'activepieces', iat: now, exp: now + 3600 * 24 * 365 },
    })
    const lines = [
        `AP_ENCRYPTION_KEY=${randomBytes(16).toString('hex')}`,
        `AP_JWT_SECRET=${jwtSecret}`,
        `AP_WORKER_TOKEN=${workerToken}`,
        `AP_TYRBO_JWT_PUBLIC_KEY=${JSON.stringify(publicKey).slice(1, -1)}`,
    ]
    writeFileSync(ENV_FILE, lines.join('\n') + '\n')
    writeFileSync(join(HERE, '.golden-private-key.pem'), privateKey)
    console.log(`wrote ${ENV_FILE}`)
    process.exit(0)
}

// ---------------------------------------------------------------------------
// suite scaffolding
// ---------------------------------------------------------------------------

let token = null
let projectId = null
const results = []
const runSummaries = []

async function api(method, path, body, { expectStatus, raw } = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (expectStatus !== undefined && res.status !== expectStatus) {
        const text = await res.text()
        throw new Error(`${method} ${path} -> ${res.status} (expected ${expectStatus}): ${text.slice(0, 500)}`)
    }
    if (!res.ok && expectStatus === undefined) {
        const text = await res.text()
        throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
    }
    if (raw) {
        return res
    }
    const text = await res.text()
    return text.length > 0 ? JSON.parse(text) : null
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

async function test(name, fn) {
    const startedAt = Date.now()
    try {
        await fn()
        results.push({ name, ok: true, ms: Date.now() - startedAt })
        console.log(`  ✓ ${name} (${Date.now() - startedAt}ms)`)
    }
    catch (err) {
        results.push({ name, ok: false, ms: Date.now() - startedAt, error: err.message })
        console.error(`  ✗ ${name}: ${err.message}`)
    }
}

// ---------------------------------------------------------------------------
// flow-building blocks (shapes match the engine's FlowAction schema)
// ---------------------------------------------------------------------------

const errorHandling = { retryOnFailure: { value: false }, continueOnFailure: { value: false } }

const codeStep = (name, code, input = {}, nextAction = undefined) => ({
    name,
    displayName: `Code ${name}`,
    type: 'CODE',
    valid: true,
    skip: false,
    settings: {
        input,
        sampleData: {},
        sourceCode: { code, packageJson: '{}' },
        errorHandlingOptions: errorHandling,
    },
    ...(nextAction ? { nextAction } : {}),
})

let webhookPieceVersion = null

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

async function listRuns(flowId) {
    const page = await api('GET', `/flow-runs?projectId=${projectId}&flowId=${flowId}&limit=50`)
    return page.data ?? []
}

async function waitForRuns(flowId, count, { statuses = ['SUCCEEDED'], timeoutMs = 90_000 } = {}) {
    return waitFor(`${count} run(s) of ${flowId} in ${statuses.join('/')}`, async () => {
        const runs = await listRuns(flowId)
        const settled = runs.filter((run) => statuses.includes(run.status))
        return settled.length >= count ? settled : false
    }, { timeoutMs })
}

async function fireWebhook(flowId, body, { sync = false } = {}) {
    const res = await fetch(`${BASE_URL}/webhooks/${flowId}${sync ? '/sync' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    return res
}

// ---------------------------------------------------------------------------
// run-completion webhook sink (criterion 4 assertion)
// ---------------------------------------------------------------------------

function startSink() {
    const server = createServer((req, res) => {
        let data = ''
        req.on('data', (chunk) => (data += chunk))
        req.on('end', () => {
            try {
                const auth = req.headers.authorization
                runSummaries.push({ auth, body: JSON.parse(data) })
            }
            catch {
                runSummaries.push({ auth: req.headers.authorization, body: null })
            }
            res.writeHead(200).end('ok')
        })
    })
    return new Promise((resolve) => server.listen(SINK_PORT, '0.0.0.0', () => resolve(server)))
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

async function main() {
    const sink = await startSink()
    console.log(`run-completion sink listening on :${SINK_PORT}`)

    console.log('waiting for engine api ...')
    await waitFor('engine api', async () => {
        const res = await fetch(`${BASE_URL}/flags`)
        return res.ok
    }, { timeoutMs: 180_000, intervalMs: 3000 })

    // -- criterion 3: authenticate through the tyrbo auth bridge ------------
    const privateKey = readFileSync(join(HERE, '.golden-private-key.pem'), 'utf8')
    const now = Math.floor(Date.now() / 1000)
    const tyrboJwt = signJwt({
        alg: 'RS256',
        key: privateKey,
        payload: {
            iss: 'tyrbo',
            aud: 'tyrbo-engine',
            sub: 'user_golden_1',
            email: 'golden@tyrbo.ai',
            first_name: 'Golden',
            last_name: 'Flow',
            org_id: 'org_golden_1',
            org_name: 'Golden Org',
            iat: now,
            exp: now + 300,
        },
    })
    const auth = await api('POST', '/tyrbo/auth/exchange', { token: tyrboJwt })
    assert(auth.token, 'exchange returned a session token')
    assert(auth.projectId, 'exchange returned a projectId')
    token = auth.token
    projectId = auth.projectId
    console.log(`authenticated via auth bridge; org project ${projectId}`)

    // second exchange must be idempotent and land on the same project
    const authAgain = await api('POST', '/tyrbo/auth/exchange', { token: tyrboJwt })
    assert(authAgain.projectId === projectId, 'exchange is idempotent for the same org')

    // a second org member (different user, same org) reaches the same project
    const memberJwt = signJwt({
        alg: 'RS256',
        key: privateKey,
        payload: {
            iss: 'tyrbo', aud: 'tyrbo-engine', sub: 'user_golden_2',
            email: 'golden2@tyrbo.ai', org_id: 'org_golden_1',
            iat: now, exp: now + 300,
        },
    })
    const memberAuth = await api('POST', '/tyrbo/auth/exchange', { token: memberJwt })
    assert(memberAuth.projectId === projectId, 'org member lands on the org project')

    // invalid tokens must come back 401 Unauthorized, never 500
    await api('POST', '/tyrbo/auth/exchange', { token: 'garbage' }, { expectStatus: 401 })
    const expiredJwt = signJwt({
        alg: 'RS256',
        key: privateKey,
        payload: {
            iss: 'tyrbo', aud: 'tyrbo-engine', sub: 'user_golden_1',
            email: 'golden@tyrbo.ai', org_id: 'org_golden_1',
            iat: now - 3600, exp: now - 60,
        },
    })
    await api('POST', '/tyrbo/auth/exchange', { token: expiredJwt }, { expectStatus: 401 })
    const wrongIssuerJwt = signJwt({
        alg: 'RS256',
        key: privateKey,
        payload: {
            iss: 'not-tyrbo', aud: 'tyrbo-engine', sub: 'user_golden_1',
            email: 'golden@tyrbo.ai', org_id: 'org_golden_1',
            iat: now, exp: now + 300,
        },
    })
    await api('POST', '/tyrbo/auth/exchange', { token: wrongIssuerJwt }, { expectStatus: 401 })
    console.log('malformed, expired, and wrong-issuer tokens all rejected with 401')

    // wait for the webhook piece to be synced from the registry
    console.log('waiting for pieces sync ...')
    await waitFor('webhook piece', async () => {
        const pieces = await api('GET', '/pieces?searchQuery=webhook')
        const found = (Array.isArray(pieces) ? pieces : pieces.data ?? []).find((piece) => piece.name === '@activepieces/piece-webhook')
        if (found) {
            webhookPieceVersion = `~${found.version}`
        }
        return Boolean(found)
    }, { timeoutMs: 300_000, intervalMs: 3000 })
    console.log(`webhook piece available (${webhookPieceVersion})`)

    // @tyrbo/piece-browser is file-loaded (AP_DEV_PIECES=browser in the golden
    // compose), so it must appear in metadata immediately — this catches image
    // trim/registration regressions on upstream merges. Full browser.run
    // execution is exercised in Farebear/tyrbo (needs the browser-worker
    // fleet, which is not part of this compose).
    await test('piece registry lists @tyrbo/piece-browser', async () => {
        const pieces = await api('GET', '/pieces?searchQuery=browser')
        const found = (Array.isArray(pieces) ? pieces : pieces.data ?? []).find((piece) => piece.name === '@tyrbo/piece-browser')
        assert(found, 'GET /pieces includes @tyrbo/piece-browser (AP_DEV_PIECES file piece)')
        const detail = await api('GET', `/pieces/${encodeURIComponent('@tyrbo/piece-browser')}`)
        assert(detail.actions && detail.actions['run'], 'piece metadata exposes the "run" action')
    })

    // -- golden flows --------------------------------------------------------

    let echoFlow = null
    await test('flow 1: webhook trigger -> code step succeeds', async () => {
        echoFlow = await createFlow('golden-webhook-echo', webhookTrigger(
            codeStep('step_1', 'export const code = async (inputs) => ({ echoed: inputs.payload });', { payload: '{{trigger.body}}' }),
        ))
        const res = await fireWebhook(echoFlow.id, { hello: 'tyrbo' })
        assert(res.ok, `webhook accepted (${res.status})`)
        await waitForRuns(echoFlow.id, 1)
    })

    await test('flow 2: webhook trigger -> synchronous response', async () => {
        const flow = await createFlow('golden-webhook-respond', webhookTrigger(
            codeStep('step_1', 'export const code = async () => ({ pong: true });', {},
                {
                    name: 'step_2',
                    displayName: 'Return Response',
                    type: 'PIECE',
                    valid: true,
                    skip: false,
                    settings: {
                        pieceName: '@activepieces/piece-webhook',
                        actionName: 'return_response',
                        pieceVersion: webhookPieceVersion,
                        input: { fields: { body: { pong: true }, status: 200, headers: {} }, respond: 'stop', responseType: 'json' },
                        sampleData: {},
                        propertySettings: {
                            fields: { type: 'MANUAL', schema: {
                                body: { type: 'JSON', required: true, displayName: 'JSON Body' },
                                status: { type: 'NUMBER', required: false, displayName: 'Status', defaultValue: 200 },
                                headers: { type: 'OBJECT', required: false, displayName: 'Headers' },
                            } },
                            respond: { type: 'MANUAL' },
                            responseType: { type: 'MANUAL' },
                        },
                        errorHandlingOptions: errorHandling,
                    },
                },
            ),
        ))
        const res = await fireWebhook(flow.id, { ping: true }, { sync: true })
        assert(res.status === 200, `sync webhook returned 200 (got ${res.status})`)
        const body = await res.json()
        assert(body.pong === true, `sync response body carries the flow output (got ${JSON.stringify(body)})`)
    })

    await test('flow 3: data passes between chained code steps', async () => {
        const flow = await createFlow('golden-chain', webhookTrigger(
            codeStep('step_1', 'export const code = async () => ({ n: 21 });', {},
                codeStep('step_2', 'export const code = async (inputs) => { if (Number(inputs.n) !== 21) throw new Error("bad input"); return { doubled: Number(inputs.n) * 2 }; }', { n: '{{step_1.n}}' }),
            ),
        ))
        await fireWebhook(flow.id, {})
        await waitForRuns(flow.id, 1)
    })

    await test('flow 4: loop over items executes body', async () => {
        const flow = await createFlow('golden-loop', webhookTrigger(
            codeStep('step_1', 'export const code = async () => ({ items: [1, 2, 3] });', {},
                {
                    name: 'loop_1',
                    displayName: 'Loop',
                    type: 'LOOP_ON_ITEMS',
                    valid: true,
                    skip: false,
                    settings: { items: '{{step_1.items}}', input: {}, sampleData: {} },
                    firstLoopAction: codeStep('step_2', 'export const code = async (inputs) => ({ item: inputs.item });', { item: '{{loop_1.item}}' }),
                },
            ),
        ))
        await fireWebhook(flow.id, {})
        await waitForRuns(flow.id, 1)
    })

    const routerFlowTrigger = () => webhookTrigger({
        name: 'router_1',
        displayName: 'Router',
        type: 'ROUTER',
        valid: true,
        skip: false,
        settings: {
            input: {},
            sampleData: {},
            executionType: 'EXECUTE_FIRST_MATCH',
            branches: [
                {
                    branchType: 'CONDITION',
                    branchName: 'route a',
                    conditions: [[{ operator: 'TEXT_EXACTLY_MATCHES', firstValue: '{{trigger.body.route}}', secondValue: 'a', caseSensitive: false }]],
                },
                { branchType: 'FALLBACK', branchName: 'otherwise' },
            ],
        },
        children: [
            codeStep('step_a', 'export const code = async () => ({ branch: "a" });'),
            codeStep('step_b', 'export const code = async () => ({ branch: "fallback" });'),
        ],
        nextAction: codeStep('step_after', 'export const code = async () => ({ joined: true });'),
    })

    let routerFlow = null
    await test('flow 5: router takes the matching branch', async () => {
        routerFlow = await createFlow('golden-router', routerFlowTrigger())
        await fireWebhook(routerFlow.id, { route: 'a' })
        await waitForRuns(routerFlow.id, 1)
    })

    await test('flow 6: router takes the fallback branch', async () => {
        await fireWebhook(routerFlow.id, { route: 'zzz' })
        await waitForRuns(routerFlow.id, 2)
    })

    let failFlow = null
    await test('flow 7: failing code step yields FAILED run', async () => {
        failFlow = await createFlow('golden-fail', webhookTrigger(
            codeStep('step_1', 'export const code = async () => { throw new Error("golden failure"); };'),
        ))
        await fireWebhook(failFlow.id, {})
        const runs = await waitForRuns(failFlow.id, 1, { statuses: ['FAILED'] })
        assert(runs[0].status === 'FAILED', 'run status is FAILED')
    })

    await test('flow 8: five concurrent webhook runs all succeed', async () => {
        await Promise.all(Array.from({ length: 5 }, (_, i) => fireWebhook(echoFlow.id, { i })))
        await waitForRuns(echoFlow.id, 6, { timeoutMs: 120_000 }) // 1 from flow 1 + 5 new
    })

    await test('flow 9: schedule trigger fires a run', async () => {
        const schedulePiece = await waitFor('schedule piece', async () => {
            const pieces = await api('GET', '/pieces?searchQuery=schedule')
            return (Array.isArray(pieces) ? pieces : pieces.data ?? []).find((piece) => piece.name === '@activepieces/piece-schedule')
        }, { timeoutMs: 120_000, intervalMs: 3000 })
        const flow = await createFlow('golden-schedule', {
            name: 'trigger',
            displayName: 'Every minute',
            type: 'PIECE_TRIGGER',
            valid: true,
            settings: {
                pieceName: '@activepieces/piece-schedule',
                pieceVersion: `~${schedulePiece.version}`,
                triggerName: 'cron_expression',
                input: { cronExpression: '* * * * *', timezone: 'UTC' },
                propertySettings: {
                    cronExpression: { type: 'MANUAL' },
                    timezone: { type: 'MANUAL' },
                },
                sampleData: {},
            },
            nextAction: codeStep('step_1', 'export const code = async () => ({ tick: true });'),
        })
        await waitForRuns(flow.id, 1, { timeoutMs: SCHEDULE_TIMEOUT_MS })
    })

    await test('flow 10: run-completion webhook delivered summaries', async () => {
        await waitFor('run summaries at the sink', () => runSummaries.length >= 5, { timeoutMs: 60_000 })
        const bodies = runSummaries.map((entry) => entry.body).filter(Boolean)
        assert(bodies.every((body) => body.runId && body.engineProjectId), 'summaries carry runId and engineProjectId')
        assert(bodies.some((body) => body.status === 'SUCCEEDED'), 'a SUCCEEDED summary arrived')
        assert(bodies.some((body) => body.status === 'FAILED'), 'the FAILED run summary arrived')
        assert(bodies.some((body) => body.orgId === 'org_golden_1'), 'summaries carry the orgId from the auth bridge')
        assert(runSummaries.every((entry) => entry.auth === 'Bearer golden-webhook-secret'), 'summaries authenticated with the webhook secret')
    })

    sink.close()

    // -- report --------------------------------------------------------------
    const failed = results.filter((r) => !r.ok)
    console.log(`\ngolden flows: ${results.length - failed.length}/${results.length} passed`)
    if (failed.length > 0) {
        for (const f of failed) {
            console.error(`  FAILED: ${f.name}: ${f.error}`)
        }
        process.exit(1)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
