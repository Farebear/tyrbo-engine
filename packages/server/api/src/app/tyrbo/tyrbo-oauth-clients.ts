// TYRBO-PATCH: env-driven platform OAuth clients — config layer.
//
// Upstream keeps "platform OAuth2 apps" (an operator-owned client id/secret
// per piece, so end users click Connect instead of pasting a client ID) in
// the deleted EE oauth-apps DB table. This community replacement reads the
// clients from the environment; tyrbo-oauth-apps.ts serves them to the
// connection dialog and installs the claim/refresh handler.
//
// Two sources, JSON winning per piece:
//
//   AP_TYRBO_OAUTH_<PROVIDER>_CLIENT_ID / AP_TYRBO_OAUTH_<PROVIDER>_CLIENT_SECRET
//       one Tyrbo-owned OAuth client per provider console; PROVIDER_PIECES
//       maps each provider to the pieces it covers. GOOGLE deliberately
//       covers only gmail + google-sheets and pins the launch scope trims
//       (sensitive-class only — tyrbo repo docs/GOOGLE-OAUTH.md §0/§3);
//       google-drive/google-forms declare restricted-class scopes and must
//       not ride the verified client until Track 2 lands.
//
//   AP_TYRBO_OAUTH_CLIENTS
//       JSON keyed by full piece name, for pieces outside the provider map
//       or to override a mapped piece (e.g. widen/narrow scopes):
//       {"@activepieces/piece-x": {"clientId": "…", "clientSecret": "…",
//        "scopes": ["optional", "authorize-time", "clamp"]}}
//
// `scopes`, when present, clamps the authorization request (oauth2-util.ts)
// to a subset of the piece-declared scopes; the connection dialog's
// select-all default still connects because clamping intersects instead of
// rejecting.
import { isNil } from '@activepieces/core-utils'
import { z } from 'zod'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'

const PROVIDER_PIECES: Record<string, Record<string, { scopes?: string[] }>> = {
    GOOGLE: {
        '@activepieces/piece-gmail': {
            scopes: ['https://www.googleapis.com/auth/gmail.send', 'email'],
        },
        '@activepieces/piece-google-sheets': {
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        },
    },
    SLACK: { '@activepieces/piece-slack': {} },
    GITHUB: { '@activepieces/piece-github': {} },
    NOTION: { '@activepieces/piece-notion': {} },
    DROPBOX: { '@activepieces/piece-dropbox': {} },
    MICROSOFT_OUTLOOK: { '@activepieces/piece-microsoft-outlook': {} },
    HUBSPOT: { '@activepieces/piece-hubspot': {} },
    ASANA: { '@activepieces/piece-asana': {} },
    CLICKUP: { '@activepieces/piece-clickup': {} },
    MAILCHIMP: { '@activepieces/piece-mailchimp': {} },
}

const clientsJsonSchema = z.record(
    z.string().min(1),
    z.object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        scopes: z.array(z.string().min(1)).optional(),
    }),
)

function parseProviderEnvClients(): Map<string, TyrboOAuthClientConfig> {
    const clients = new Map<string, TyrboOAuthClientConfig>()
    for (const [provider, pieces] of Object.entries(PROVIDER_PIECES)) {
        // dynamic provider suffix, so read the environment directly instead of
        // one AppSystemProp per provider; AP_TYRBO_OAUTH_CLIENTS remains the
        // typed escape hatch
        const clientId = process.env[`AP_TYRBO_OAUTH_${provider}_CLIENT_ID`]
        const clientSecret = process.env[`AP_TYRBO_OAUTH_${provider}_CLIENT_SECRET`]
        if (isNil(clientId) || clientId === '' || isNil(clientSecret) || clientSecret === '') {
            continue
        }
        for (const [pieceName, { scopes }] of Object.entries(pieces)) {
            clients.set(pieceName, { clientId, clientSecret, scopes })
        }
    }
    return clients
}

function parseJsonClients(): Map<string, TyrboOAuthClientConfig> {
    const raw = system.get(AppSystemProp.TYRBO_OAUTH_CLIENTS)
    if (isNil(raw) || raw === '') {
        return new Map()
    }
    const parsed = clientsJsonSchema.parse(JSON.parse(raw))
    return new Map(Object.entries(parsed))
}

export function validateTyrboOAuthClientsJson(value: string): true | string {
    try {
        clientsJsonSchema.parse(JSON.parse(value))
        return true
    }
    catch (e) {
        return `Value must be JSON of {"<pieceName>": {"clientId", "clientSecret", "scopes"?}}: ${e instanceof Error ? e.message : String(e)}`
    }
}

export const tyrboOAuthClients = {
    all(): Map<string, TyrboOAuthClientConfig> {
        const clients = parseProviderEnvClients()
        for (const [pieceName, config] of parseJsonClients()) {
            clients.set(pieceName, config)
        }
        return clients
    },
    // Piece names with a configured platform OAuth client, for the product's
    // public connector-gallery discovery (tyrbo-oauth-apps.ts GET /pieces).
    // Piece names — not provider ids — are the stable identifier both repos
    // share (the engine's PROVIDER_PIECES key MICROSOFT_OUTLOOK is the web's
    // "microsoft"), and per-piece truth keeps google-drive/forms correctly
    // "coming soon" even when GOOGLE is configured.
    configuredPieceNames(): string[] {
        return [...tyrboOAuthClients.all().keys()]
    },
    getForPiece(pieceName: string): TyrboOAuthClientConfig | undefined {
        return tyrboOAuthClients.all().get(pieceName)
    },
    // authorize-time scope clamp: only applies when the request actually uses
    // the configured client (BYO connections for the same piece stay untouched)
    getScopeClamp({ pieceName, clientId }: GetScopeClampParams): string[] | undefined {
        const config = tyrboOAuthClients.all().get(pieceName)
        if (isNil(config) || config.clientId !== clientId || isNil(config.scopes)) {
            return undefined
        }
        return config.scopes
    },
}

export type TyrboOAuthClientConfig = {
    clientId: string
    clientSecret: string
    scopes?: string[]
}

type GetScopeClampParams = {
    pieceName: string
    clientId: string
}
