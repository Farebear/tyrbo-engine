import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    tyrboOAuthClients,
    validateTyrboOAuthClientsJson,
} from '../../../../src/app/tyrbo/tyrbo-oauth-clients'

const ENV_KEYS = [
    'AP_TYRBO_OAUTH_SLACK_CLIENT_ID',
    'AP_TYRBO_OAUTH_SLACK_CLIENT_SECRET',
    'AP_TYRBO_OAUTH_GOOGLE_CLIENT_ID',
    'AP_TYRBO_OAUTH_GOOGLE_CLIENT_SECRET',
    'AP_TYRBO_OAUTH_CLIENTS',
]

describe('tyrboOAuthClients', () => {
    beforeEach(() => {
        for (const key of ENV_KEYS) {
            Reflect.deleteProperty(process.env, key)
        }
    })

    afterEach(() => {
        for (const key of ENV_KEYS) {
            Reflect.deleteProperty(process.env, key)
        }
    })

    it('is empty when nothing is configured', () => {
        expect(tyrboOAuthClients.all().size).toBe(0)
        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-slack')).toBeUndefined()
    })

    it('maps a provider client pair onto its pieces', () => {
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_ID = 'slack-id'
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_SECRET = 'slack-secret'

        const client = tyrboOAuthClients.getForPiece('@activepieces/piece-slack')
        expect(client).toEqual({ clientId: 'slack-id', clientSecret: 'slack-secret', scopes: undefined })
    })

    it('ignores a provider with a missing secret half', () => {
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_ID = 'slack-id'

        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-slack')).toBeUndefined()
    })

    it('pins the launch scope trims on the GOOGLE provider and leaves restricted-scope pieces out', () => {
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_ID = 'google-id'
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret'

        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-gmail')?.scopes).toEqual([
            'https://www.googleapis.com/auth/gmail.send',
            'email',
        ])
        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-google-sheets')?.scopes).toEqual([
            'https://www.googleapis.com/auth/spreadsheets',
        ])
        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-google-drive')).toBeUndefined()
        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-google-forms')).toBeUndefined()
    })

    it('reads pieces from the JSON config', () => {
        process.env.AP_TYRBO_OAUTH_CLIENTS = JSON.stringify({
            '@activepieces/piece-github': { clientId: 'gh-id', clientSecret: 'gh-secret' },
        })

        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-github')).toEqual({
            clientId: 'gh-id',
            clientSecret: 'gh-secret',
        })
    })

    it('lets the JSON config override a provider-mapped piece', () => {
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_ID = 'google-id'
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret'
        process.env.AP_TYRBO_OAUTH_CLIENTS = JSON.stringify({
            '@activepieces/piece-gmail': {
                clientId: 'override-id',
                clientSecret: 'override-secret',
                scopes: ['https://www.googleapis.com/auth/gmail.send'],
            },
        })

        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-gmail')).toEqual({
            clientId: 'override-id',
            clientSecret: 'override-secret',
            scopes: ['https://www.googleapis.com/auth/gmail.send'],
        })
        expect(tyrboOAuthClients.getForPiece('@activepieces/piece-google-sheets')?.clientId).toBe('google-id')
    })

    it('clamps scopes only for the configured client id', () => {
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_ID = 'google-id'
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret'

        expect(tyrboOAuthClients.getScopeClamp({
            pieceName: '@activepieces/piece-gmail',
            clientId: 'google-id',
        })).toEqual(['https://www.googleapis.com/auth/gmail.send', 'email'])
        expect(tyrboOAuthClients.getScopeClamp({
            pieceName: '@activepieces/piece-gmail',
            clientId: 'someone-elses-byo-client',
        })).toBeUndefined()
    })

    it('returns no clamp for clients configured without scopes', () => {
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_ID = 'slack-id'
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_SECRET = 'slack-secret'

        expect(tyrboOAuthClients.getScopeClamp({
            pieceName: '@activepieces/piece-slack',
            clientId: 'slack-id',
        })).toBeUndefined()
    })

    it('configuredPieceNames is empty when nothing is configured', () => {
        expect(tyrboOAuthClients.configuredPieceNames()).toEqual([])
    })

    it('configuredPieceNames lists only the pieces a configured provider covers', () => {
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_ID = 'google-id'
        process.env.AP_TYRBO_OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret'

        const pieces = tyrboOAuthClients.configuredPieceNames().sort()
        expect(pieces).toEqual([
            '@activepieces/piece-gmail',
            '@activepieces/piece-google-sheets',
        ])
        // restricted-scope google pieces stay out, so the gallery keeps their
        // "coming soon" badge even while GOOGLE is configured
        expect(pieces).not.toContain('@activepieces/piece-google-drive')
    })

    it('configuredPieceNames includes JSON-configured pieces alongside env pairs', () => {
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_ID = 'slack-id'
        process.env.AP_TYRBO_OAUTH_SLACK_CLIENT_SECRET = 'slack-secret'
        process.env.AP_TYRBO_OAUTH_CLIENTS = JSON.stringify({
            '@activepieces/piece-github': { clientId: 'gh-id', clientSecret: 'gh-secret' },
        })

        expect(tyrboOAuthClients.configuredPieceNames().sort()).toEqual([
            '@activepieces/piece-github',
            '@activepieces/piece-slack',
        ])
    })
})

describe('validateTyrboOAuthClientsJson', () => {
    it('accepts a well-formed config', () => {
        const value = JSON.stringify({
            '@activepieces/piece-notion': {
                clientId: 'id',
                clientSecret: 'secret',
                scopes: ['a'],
            },
        })
        expect(validateTyrboOAuthClientsJson(value)).toBe(true)
    })

    it('rejects malformed JSON', () => {
        expect(validateTyrboOAuthClientsJson('{nope')).toContain('Value must be JSON')
    })

    it('rejects entries missing the client secret', () => {
        const value = JSON.stringify({
            '@activepieces/piece-notion': { clientId: 'id' },
        })
        expect(validateTyrboOAuthClientsJson(value)).toContain('Value must be JSON')
    })
})
