// TYRBO-PATCH: Tyrbo-managed Trello connect — server-side credential injection.
//
// Upstream's Trello piece makes every user paste an API Key + Token. Tyrbo holds
// ONE platform-owned Trello Power-Up API key and each user mints a per-user token
// via Trello's authorize flow; the connection stores only that token
// (CUSTOM_AUTH { token }).
//
// The API key is injected into the resolved CUSTOM_AUTH props here, server-side —
// as `username` (token becomes `password`, the shape legacy BYO BASIC_AUTH paste
// connections already carry) — at the two points the piece needs it:
//   - connection resolve  (app-connection-worker-controller.ts) — runtime auth +
//     the board/list/label dropdowns, both of which the engine resolves through
//     that endpoint;
//   - connection validate (app-connection-service.ts)          — the piece's
//     validate() lists the user's boards.
//
// Injecting server-side (rather than reading the key in the sandboxed engine,
// whose env is the AP_SANDBOX_PROPAGATED_ENV_VARS allowlist) keeps it zero-setup:
// the key stays in the API process env and travels only inside the trello
// connection value over the authenticated engine<->API channel.
//
// Every injection is a no-op unless the piece is trello, the stored value is
// CUSTOM_AUTH with a token, and AP_TYRBO_TRELLO_API_KEY is set — so legacy pasted
// BASIC_AUTH connections and non-Tyrbo deployments are left exactly as-is. The
// authorize-URL endpoint builds the Trello authorize URL the product's Connect
// flow opens; least privilege scope=read,write, and return_url is pinned to this
// instance's own AP_FRONTEND_URL so the minted token can only return to us.
//
// See .agents/features/trello-shared-connect.md.
import { ActivepiecesError, ErrorCode, isNil } from '@activepieces/core-utils'
import { AppConnectionType, AppConnectionValue, PrincipalType } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { platformService } from '../platform/platform.service'

const TRELLO_PIECE_NAME = '@activepieces/piece-trello'

export const tyrboTrelloConnectModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(tyrboTrelloConnectController, { prefix: '/v1/tyrbo/trello' })
}

const tyrboTrelloConnectController: FastifyPluginAsyncZod = async (app) => {
    app.get('/authorize-url', AuthorizeUrlRequest, async (request): Promise<TrelloAuthorizeUrlResponse> => {
        const platform = await platformService(request.log).getOneOrThrow(request.principal.platform.id)
        return { authorizeUrl: buildTrelloAuthorizeUrl({ appName: platform.name }) }
    })
}

// Runtime resolve + connection validate need the same thing: the platform key
// merged onto the stored token. `context.auth` is read through the piece's
// toTrelloCreds bridge, which accepts both the flattened props (validate, context
// V0) and the full { type, props } value (actions/dropdowns, context V1).
export function injectTrelloPlatformKey({ pieceName, value }: InjectTrelloPlatformKeyParams): AppConnectionValue {
    const apiKey = readEnv(AppSystemProp.TYRBO_TRELLO_API_KEY)
    if (pieceName !== TRELLO_PIECE_NAME || isNil(apiKey) || value.type !== AppConnectionType.CUSTOM_AUTH) {
        return value
    }
    const token = value.props?.token
    if (isNil(token) || typeof token !== 'string' || token === '') {
        return value
    }
    return {
        ...value,
        props: {
            ...value.props,
            username: apiKey,
            password: token,
        },
    }
}

export function isTrelloPlatformKeyConfigured(): boolean {
    return !isNil(readEnv(AppSystemProp.TYRBO_TRELLO_API_KEY))
}

function buildTrelloAuthorizeUrl({ appName }: { appName: string }): string {
    const apiKey = getConfiguredApiKeyOrThrow()
    const frontendUrl = system.getOrThrow(AppSystemProp.FRONTEND_URL).replace(/\/$/, '')
    const params = new URLSearchParams({
        expiration: 'never',
        scope: 'read,write',
        response_type: 'token',
        name: appName,
        key: apiKey,
        return_url: `${frontendUrl}/redirect`,
        callback_method: 'fragment',
    })
    return `https://trello.com/1/authorize?${params.toString()}`
}

function getConfiguredApiKeyOrThrow(): string {
    const apiKey = readEnv(AppSystemProp.TYRBO_TRELLO_API_KEY)
    if (isNil(apiKey)) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_APP_CONNECTION,
            params: {
                error: 'Trello is not configured on this instance: set AP_TYRBO_TRELLO_API_KEY to enable Trello connections.',
            },
        })
    }
    return apiKey
}

function readEnv(prop: AppSystemProp): string | undefined {
    const value = system.get(prop)
    return isNil(value) || value === '' ? undefined : value
}

const AuthorizeUrlRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

type InjectTrelloPlatformKeyParams = {
    pieceName: string
    value: AppConnectionValue
}

type TrelloAuthorizeUrlResponse = {
    authorizeUrl: string
}
