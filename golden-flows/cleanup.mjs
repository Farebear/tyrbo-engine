// TYRBO-PATCH: disable + delete every flow in the golden org's project.
//
// The suite leaves its flows ENABLED and golden-schedule fires every minute —
// run this after EVERY staging suite run or the worker burns cycles forever:
//
//   BASE_URL=https://tyrbo-engine-api-staging.fly.dev/api/v1 node cleanup.mjs
//
// Signs the auth-bridge JWT with .golden-private-key.pem (for staging, write
// the staging private key there first; see tyrbo-deploy/README.md).
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080/api/v1'
const pem = readFileSync(process.env.PRIVATE_KEY_PATH ?? join(HERE, '.golden-private-key.pem'), 'utf8')

const b64url = (input) => Buffer.from(input).toString('base64url')
function signJwt(payload) {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: '1' }))
    const body = b64url(JSON.stringify(payload))
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${body}`)
    return `${header}.${body}.${signer.sign(pem, 'base64url')}`
}

const now = Math.floor(Date.now() / 1000)
const jwt = signJwt({
    iss: 'tyrbo', aud: 'tyrbo-engine', sub: 'user_golden_1',
    email: 'golden@tyrbo.ai', org_id: 'org_golden_1',
    iat: now, exp: now + 300,
})
const exchange = await fetch(`${BASE_URL}/tyrbo/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: jwt }),
})
if (!exchange.ok) throw new Error(`auth exchange failed: ${exchange.status}`)
const { token, projectId } = await exchange.json()
const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

const listFlows = async () => {
    const res = await fetch(`${BASE_URL}/flows?projectId=${projectId}&limit=100`, { headers })
    if (!res.ok) throw new Error(`flow list failed: ${res.status}`)
    return (await res.json()).data ?? []
}

const flows = await listFlows()
console.log(`project ${projectId}: ${flows.length} flow(s)`)
for (const flow of flows) {
    const disable = await fetch(`${BASE_URL}/flows/${flow.id}`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'CHANGE_STATUS', request: { status: 'DISABLED' } }),
    })
    // no Content-Type here: fastify 400s a body-less DELETE that claims JSON
    const del = await fetch(`${BASE_URL}/flows/${flow.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': headers.Authorization },
    })
    console.log(`  ${flow.id} (${flow.status}) -> disable ${disable.status}, delete ${del.status}`)
}
const remaining = await listFlows()
console.log(`remaining flows: ${remaining.length}`)
if (remaining.length > 0) {
    for (const flow of remaining) console.log(`  STILL PRESENT: ${flow.id} ${flow.status}`)
    process.exit(1)
}
