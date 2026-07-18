import { ActivepiecesError, assertNotNullOrUndefined, ErrorCode, isNil } from '@activepieces/core-utils'
import { AppConnection, EnginePrincipal, GetAppConnectionForWorkerRequestQuery } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { secretManagersService } from '../tyrbo/ce-defaults'
import { tyrboDiscordBot } from '../tyrbo/tyrbo-discord-bot'
import { appConnectionService } from './app-connection-service/app-connection-service'

export const appConnectionWorkerController: FastifyPluginAsyncZod = async (app) => {

    app.get('/:externalId', GetAppConnectionRequest, async (request): Promise<AppConnection> => {
        const enginePrincipal = (request.principal as EnginePrincipal)
        assertNotNullOrUndefined(enginePrincipal.projectId, 'projectId')
        const appConnection = await appConnectionService(request.log).getOne({
            projectId: enginePrincipal.projectId,
            platformId: enginePrincipal.platform.id,
            externalId: request.params.externalId,
        })

        if (isNil(appConnection)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: `externalId=${request.params.externalId}`,
                    entityType: 'AppConnection',
                },
            })
        }

        const resolvedValue = await secretManagersService(request.log).resolveObject({ value: appConnection.value, projectIds: [enginePrincipal.projectId], platformId: enginePrincipal.platform.id, throwOnFailure: false })

        return {
            ...appConnection,
            // TYRBO-PATCH: merge the shared platform Discord bot token onto the resolved
            // value so actions/dropdowns get `{ ...props, secret_text }`. No-op for every
            // other piece, for non-CUSTOM_AUTH connections, and when the token is unset.
            value: tyrboDiscordBot.injectForRuntime({ pieceName: appConnection.pieceName, value: resolvedValue }),
        }
    },
    )

}

const GetAppConnectionRequest = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        params: GetAppConnectionForWorkerRequestQuery,
    },
}
