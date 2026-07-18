// TYRBO-PATCH: unit tests for the deploy/drift pin logic. Runs standalone
// under `node --test tyrbo-deploy/scripts/image-pin.test.mjs` — no vitest /
// turbo / bun needed, so the drift workflow can gate it on any runner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareImagePin, parseDeployedImages, parseImageRef, parsePinnedImage } from './image-pin.mjs'

const API_TOML = `# a comment
app = "tyrbo-engine-api-staging"

[build]
image = "ghcr.io/farebear/tyrbo-engine-api:80d55d544f64931f4c5c45a00377ffd5349ba137"

[env]
image = "should-be-ignored-not-in-build-section"
`

test('parsePinnedImage extracts the [build] image and its tag', () => {
    const pin = parsePinnedImage(API_TOML)
    assert.equal(pin.name, 'ghcr.io/farebear/tyrbo-engine-api')
    assert.equal(pin.tag, '80d55d544f64931f4c5c45a00377ffd5349ba137')
    assert.equal(pin.ref, 'ghcr.io/farebear/tyrbo-engine-api:80d55d544f64931f4c5c45a00377ffd5349ba137')
})

test('parsePinnedImage ignores commented lines and non-build sections', () => {
    const pin = parsePinnedImage(API_TOML)
    // the [env] image line must not win over [build]
    assert.equal(pin.ref.endsWith(':80d55d544f64931f4c5c45a00377ffd5349ba137'), true)
})

test('parsePinnedImage throws when there is no [build] image', () => {
    assert.throws(() => parsePinnedImage('app = "x"\n[env]\nfoo = "bar"\n'), /no \[build\] image/)
})

test('parseImageRef splits registry/repo name from tag', () => {
    const parsed = parseImageRef('ghcr.io/farebear/tyrbo-engine-worker:abc123')
    assert.equal(parsed.name, 'ghcr.io/farebear/tyrbo-engine-worker')
    assert.equal(parsed.tag, 'abc123')
    assert.equal(parsed.digest, null)
})

test('parseImageRef handles a digest ref without misreading the tag', () => {
    const parsed = parseImageRef('ghcr.io/farebear/tyrbo-engine-api@sha256:deadbeef')
    assert.equal(parsed.name, 'ghcr.io/farebear/tyrbo-engine-api')
    assert.equal(parsed.tag, null)
    assert.equal(parsed.digest, 'sha256:deadbeef')
})

test('parseDeployedImages maps the flyctl json array', () => {
    const deployed = parseDeployedImages(JSON.stringify([
        { Registry: 'ghcr.io', Repository: 'farebear/tyrbo-engine-api', Tag: 'sha1', Digest: 'sha256:aaa', MachineID: 'm1' },
    ]))
    assert.deepEqual(deployed, [
        { name: 'ghcr.io/farebear/tyrbo-engine-api', tag: 'sha1', digest: 'sha256:aaa', machineId: 'm1' },
    ])
})

test('parseDeployedImages rejects a non-array payload', () => {
    assert.throws(() => parseDeployedImages('{}'), /return an array/)
})

test('compareImagePin reports in-sync when the deployed tag matches the pin', () => {
    const committed = parseImageRef('ghcr.io/farebear/tyrbo-engine-api:sha1')
    const deployed = parseDeployedImages([
        { Registry: 'ghcr.io', Repository: 'farebear/tyrbo-engine-api', Tag: 'sha1', MachineID: 'm1' },
    ])
    const result = compareImagePin({ committed, deployed })
    assert.equal(result.drifted, false)
    assert.equal(result.reason, 'in-sync')
    assert.deepEqual(result.mismatches, [])
})

test('compareImagePin detects a stale deployed tag (the undeployed-pin case)', () => {
    const committed = parseImageRef('ghcr.io/farebear/tyrbo-engine-api:80d55d544f')
    const deployed = parseDeployedImages([
        { Registry: 'ghcr.io', Repository: 'farebear/tyrbo-engine-api', Tag: 'f460c4cf05', MachineID: 'm1' },
    ])
    const result = compareImagePin({ committed, deployed })
    assert.equal(result.drifted, true)
    assert.equal(result.reason, 'image-mismatch')
    assert.equal(result.committedRef, 'ghcr.io/farebear/tyrbo-engine-api:80d55d544f')
    assert.equal(result.mismatches[0].ref, 'ghcr.io/farebear/tyrbo-engine-api:f460c4cf05')
})

test('compareImagePin flags a partial deploy across machines', () => {
    const committed = parseImageRef('ghcr.io/farebear/tyrbo-engine-api:sha2')
    const deployed = parseDeployedImages([
        { Registry: 'ghcr.io', Repository: 'farebear/tyrbo-engine-api', Tag: 'sha2', MachineID: 'm1' },
        { Registry: 'ghcr.io', Repository: 'farebear/tyrbo-engine-api', Tag: 'sha1', MachineID: 'm2' },
    ])
    const result = compareImagePin({ committed, deployed })
    assert.equal(result.drifted, true)
    assert.equal(result.mismatches.length, 1)
    assert.equal(result.mismatches[0].machineId, 'm2')
})

test('compareImagePin treats zero deployed machines as drift', () => {
    const committed = parseImageRef('ghcr.io/farebear/tyrbo-engine-api:sha1')
    const result = compareImagePin({ committed, deployed: [] })
    assert.equal(result.drifted, true)
    assert.equal(result.reason, 'no-deployed-image')
})
