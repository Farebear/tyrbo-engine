import { generateKeyPairSync } from 'node:crypto'
import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import jwtLibrary from 'jsonwebtoken'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { errorHandler } from '../../../../src/app/helper/error-handler'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { verifyTyrboToken } from '../../../../src/app/tyrbo/tyrbo-auth-bridge'

const ISSUER = 'tyrbo'
const AUDIENCE = 'tyrbo-engine'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const { privateKey: strangerPrivateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const validClaims = {
    sub: 'user_1',
    email: 'user@tyrbo.ai',
    org_id: 'org_1',
    org_name: 'Org One',
}

type SignTokenOverrides = {
    payload?: Record<string, unknown>
    key?: string
    issuer?: string
    audience?: string
    expiresInSeconds?: number
}

function signToken({ payload = validClaims, key = privateKey, issuer = ISSUER, audience = AUDIENCE, expiresInSeconds = 300 }: SignTokenOverrides = {}): string {
    return jwtLibrary.sign(payload, key, {
        algorithm: 'RS256',
        keyid: '1',
        issuer,
        audience,
        expiresIn: expiresInSeconds,
    })
}

// The regression this guards: bad tokens must surface as an
// ActivepiecesError the global errorHandler maps to 401 — anything
// else falls through to a 500.
async function expectUnauthorized(promise: Promise<unknown>): Promise<void> {
    const outcome = await promise.then(
        () => null,
        (error: unknown) => error,
    )
    expect(outcome, 'expected token verification to throw').not.toBeNull()
    expect(outcome).toBeInstanceOf(ActivepiecesError)
    expect((outcome as ActivepiecesError).error.code).toBe(ErrorCode.AUTHENTICATION)

    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() }
    await errorHandler(outcome as FastifyError, {} as FastifyRequest, reply as unknown as FastifyReply)
    expect(reply.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED)
}

beforeAll(() => {
    vi.spyOn(system, 'get').mockImplementation((prop) => {
        switch (prop) {
            case AppSystemProp.TYRBO_JWT_PUBLIC_KEY:
                return publicKey
            case AppSystemProp.TYRBO_JWT_ISSUER:
                return ISSUER
            default:
                return undefined
        }
    })
})

describe('verifyTyrboToken', () => {
    it('returns the claims for a valid token', async () => {
        const claims = await verifyTyrboToken(signToken())

        expect(claims.sub).toBe('user_1')
        expect(claims.email).toBe('user@tyrbo.ai')
        expect(claims.org_id).toBe('org_1')
        expect(claims.org_name).toBe('Org One')
    })

    it('rejects a malformed token with 401', async () => {
        await expectUnauthorized(verifyTyrboToken('garbage'))
    })

    it('rejects an expired token with 401', async () => {
        await expectUnauthorized(verifyTyrboToken(signToken({ expiresInSeconds: -60 })))
    })

    it('rejects a token from the wrong issuer with 401', async () => {
        await expectUnauthorized(verifyTyrboToken(signToken({ issuer: 'not-tyrbo' })))
    })

    it('rejects a token for the wrong audience with 401', async () => {
        await expectUnauthorized(verifyTyrboToken(signToken({ audience: 'some-other-engine' })))
    })

    it('rejects a token signed with an unknown key with 401', async () => {
        await expectUnauthorized(verifyTyrboToken(signToken({ key: strangerPrivateKey })))
    })

    it('rejects a well-signed token missing required claims with 401', async () => {
        await expectUnauthorized(verifyTyrboToken(signToken({ payload: { sub: 'user_1', email: 'user@tyrbo.ai' } })))
    })
})
