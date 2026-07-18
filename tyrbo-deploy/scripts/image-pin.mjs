// TYRBO-PATCH: shared image-pin parsing + drift comparison for the staging
// engine deploy automation.
//
// The committed pin is the `[build] image` line in the fly.*.staging.toml
// files; the deployed image is what `flyctl image show --app <app> --json`
// reports. The gap between those two is exactly the failure this automation
// prevents: a repin commit (e.g. engine PR #21) that lands in git but never
// reaches Fly, so staging silently keeps running the old image.
//
// Everything here is a PURE function (no filesystem, no flyctl) so
// image-pin.test.mjs can exercise it under `node --test`. The CLIs
// (deploy-staging.mjs, check-image-drift.mjs) own the I/O.

export function parsePinnedImage(tomlText) {
    let section = null
    for (const rawLine of tomlText.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (line.startsWith('#') || line.length === 0) {
            continue
        }
        const sectionMatch = line.match(/^\[+([^\]]+)\]+/)
        if (sectionMatch) {
            section = sectionMatch[1].trim()
            continue
        }
        if (section !== 'build') {
            continue
        }
        const imageMatch = line.match(/^image\s*=\s*["']([^"']+)["']/)
        if (imageMatch) {
            return parseImageRef(imageMatch[1])
        }
    }
    throw new Error('no [build] image line found in fly toml')
}

export function parseImageRef(ref) {
    let name = ref
    let digest = null
    const atIndex = ref.indexOf('@')
    if (atIndex !== -1) {
        digest = ref.slice(atIndex + 1)
        name = ref.slice(0, atIndex)
    }
    let tag = null
    const colonIndex = name.lastIndexOf(':')
    // a ':' only introduces a tag when it comes after the final '/', otherwise
    // it is a registry port (host:port/repo) — not the case for ghcr.io but
    // handled so the parser is not silently wrong on a future registry change
    if (colonIndex > name.lastIndexOf('/')) {
        tag = name.slice(colonIndex + 1)
        name = name.slice(0, colonIndex)
    }
    return { name, tag, digest, ref }
}

export function parseDeployedImages(showJson) {
    const rows = typeof showJson === 'string' ? JSON.parse(showJson) : showJson
    if (!Array.isArray(rows)) {
        throw new Error('expected `flyctl image show --json` to return an array')
    }
    return rows.map((row) => ({
        name: [row.Registry, row.Repository].filter(Boolean).join('/'),
        tag: row.Tag ?? null,
        digest: row.Digest ?? null,
        machineId: row.MachineID ?? null,
    }))
}

export function compareImagePin({ committed, deployed }) {
    const committedRef = `${committed.name}:${committed.tag}`
    if (!Array.isArray(deployed) || deployed.length === 0) {
        return {
            drifted: true,
            reason: 'no-deployed-image',
            committedRef,
            deployedRefs: [],
            mismatches: [],
        }
    }
    const withRefs = deployed.map((image) => ({ ...image, ref: `${image.name}:${image.tag}` }))
    const mismatches = withRefs.filter(
        (image) => image.name !== committed.name || image.tag !== committed.tag,
    )
    return {
        drifted: mismatches.length > 0,
        reason: mismatches.length > 0 ? 'image-mismatch' : 'in-sync',
        committedRef,
        deployedRefs: withRefs.map((image) => image.ref),
        mismatches: mismatches.map((image) => ({ ref: image.ref, machineId: image.machineId })),
    }
}
