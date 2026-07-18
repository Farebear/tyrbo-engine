// TYRBO-PATCH: Tyrbo-managed Trello connect — server helpers + authorize-URL API.
//
// Upstream Trello is a two-value paste (API Key + Token). Tyrbo instead holds a
// single Trello Power-Up API key (AP_TYRBO_TRELLO_API_KEY) and each user mints a
// per-user token via Trello's authorize flow; the connection stores only that
// token. This module owns the two server-side halves of that model:
//
//   injectTrelloValidationKey
//       executeValidateAuth receives the entered value directly (it does NOT go
//       through the engine connection-resolver, which handles run-time
//       injection), so the platform key is injected here — as the BASIC_AUTH
//       username the piece reads — so the piece's validate() can call Trello.
//       Passthrough for every other piece and for legacy BYO BASIC_AUTH
//       connections; a missing key on a Trello CUSTOM_AUTH connection surfaces
//       as a loud misconfiguration rather than a silent run-time failure.
//
//   GET /v1/tyrbo/trello/authorize-url
//       builds the Trello authorize URL the product's Connect flow opens. The
//       return_url is pinned to this instance's own AP_FRONTEND_URL (never a
//       caller-supplied value) so the minted token can only ever come back to
//       us. Least privilege: scope=read,write, never account.
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

export function injectTrelloValidationKey({ pieceName, value }: InjectTrelloValidationKeyParams): AppConnectionValue {
    if (pieceName !== TRELLO_PIECE_NAME || value.type !== AppConnectionType.CUSTOM_AUTH) {
        return value
    }
    const token = value.props?.token
    if (isNil(token) || typeof token !== 'string' || token === '') {
        return value
    }
    const apiKey = getConfiguredApiKeyOrThrow()
    return {
        type: AppConnectionType.CUSTOM_AUTH,
        props: { username: apiKey, password: token },
    }
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
    const apiKey = system.get(AppSystemProp.TYRBO_TRELLO_API_KEY)
    if (isNil(apiKey) || apiKey === '') {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_APP_CONNECTION,
            params: {
                error: 'Trello is not configured on this instance: set AP_TYRBO_TRELLO_API_KEY to enable Trello connections.',
            },
        })
    }
    return apiKey
}

const AuthorizeUrlRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

type InjectTrelloValidationKeyParams = {
    pieceName: string
    value: AppConnectionValue
}

type TrelloAuthorizeUrlResponse = {
    authorizeUrl: string
}
