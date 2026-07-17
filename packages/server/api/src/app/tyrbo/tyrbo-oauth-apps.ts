// TYRBO-PATCH: env-driven platform OAuth clients — API surface.
//
// Community replacement for the deleted EE oauth-apps module, backed by the
// environment (tyrbo-oauth-clients.ts) instead of the oauth_app table:
//
//   GET /v1/oauth-apps
//       the connection dialog's discovery call. Returns the configured
//       pieces with client ids only — secrets never leave the server. A
//       piece listed here renders a Connect-only dialog (PLATFORM_OAUTH2);
//       everything else keeps the community BYO client-id form. Upsert and
//       delete stay unimplemented: the environment is the source of truth.
//
//   tyrboPlatformOAuth2Service
//       installed via setPlatformOAuthService() in app.ts. Claim/refresh
//       delegate to the community credentials service with the configured
//       client id/secret injected server-side; the stored connection value
//       keeps type PLATFORM_OAUTH2 and never embeds the client secret.
import { ActivepiecesError, assertNotNullOrUndefined, ErrorCode, isNil } from '@activepieces/core-utils'
import {
    AppConnectionType,
    OAuthApp,
    PlatformOAuth2ConnectionValue,
    PrincipalType,
    SeekPage,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
    ClaimOAuth2Request,
    OAuth2Service,
    RefreshOAuth2Request,
} from '../app-connection/app-connection-service/oauth2/oauth2-service'
import { credentialsOauth2Service } from '../app-connection/app-connection-service/oauth2/services/credentials-oauth2-service'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { TyrboOAuthClientConfig, tyrboOAuthClients } from './tyrbo-oauth-clients'

const EPOCH = new Date(0).toISOString()

export const tyrboOAuthAppsModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(tyrboOAuthAppsController, { prefix: '/v1/oauth-apps' })
}

const tyrboOAuthAppsController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListOAuthAppsRequest, async (request): Promise<SeekPage<OAuthApp>> => {
        const platformId = request.principal.platform.id
        return {
            data: listOAuthApps(platformId),
            next: null,
            previous: null,
        }
    })
}

export function listOAuthApps(platformId: string): OAuthApp[] {
    return [...tyrboOAuthClients.all().entries()].map(([pieceName, config]) => ({
        id: `tyrbo-oauth-${pieceName.split('/').pop() ?? pieceName}`,
        created: EPOCH,
        updated: EPOCH,
        pieceName,
        platformId,
        clientId: config.clientId,
    }))
}

export const tyrboPlatformOAuth2Service = (log: FastifyBaseLogger): OAuth2Service<PlatformOAuth2ConnectionValue> => ({
    async claim({ request, pieceName, projectId, platformId }: ClaimOAuth2Request): Promise<PlatformOAuth2ConnectionValue> {
        const client = getConfiguredClientOrThrow(pieceName)
        assertNotNullOrUndefined(request.redirectUrl, 'redirectUrl')
        const { client_secret: _clientSecret, type: _type, ...claimed } = await credentialsOauth2Service(log).claim({
            projectId,
            platformId,
            pieceName,
            request: {
                ...request,
                clientId: client.clientId,
                clientSecret: client.clientSecret,
            },
        })
        return {
            ...claimed,
            client_id: client.clientId,
            type: AppConnectionType.PLATFORM_OAUTH2,
            redirect_url: request.redirectUrl,
        }
    },

    async refresh({ pieceName, projectId, platformId, connectionValue }: RefreshOAuth2Request<PlatformOAuth2ConnectionValue>): Promise<PlatformOAuth2ConnectionValue> {
        const client = getConfiguredClientOrThrow(pieceName)
        const { client_secret: _clientSecret, type: _type, ...refreshed } = await credentialsOauth2Service(log).refresh({
            pieceName,
            projectId,
            platformId,
            connectionValue: {
                ...connectionValue,
                type: AppConnectionType.OAUTH2,
                client_id: client.clientId,
                client_secret: client.clientSecret,
                redirect_url: connectionValue.redirect_url,
            },
        })
        return {
            ...refreshed,
            client_id: client.clientId,
            type: AppConnectionType.PLATFORM_OAUTH2,
            redirect_url: connectionValue.redirect_url,
        }
    },
})

function getConfiguredClientOrThrow(pieceName: string): TyrboOAuthClientConfig {
    const client = tyrboOAuthClients.getForPiece(pieceName)
    if (isNil(client)) {
        throw new ActivepiecesError({
            code: ErrorCode.INVALID_APP_CONNECTION,
            params: {
                error: `no Tyrbo-managed OAuth client is configured for ${pieceName}; reconnect with your own client credentials`,
            },
        })
    }
    return client
}

const ListOAuthAppsRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        querystring: z.object({
            limit: z.coerce.number().optional(),
            cursor: z.string().optional(),
        }),
    },
}
