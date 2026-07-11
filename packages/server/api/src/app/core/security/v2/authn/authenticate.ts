import { ActivepiecesError, ErrorCode, isNil } from '@activepieces/core-utils'
import { Principal, PrincipalType } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { accessTokenManager } from '../../../../authentication/lib/access-token-manager'

export const authenticateOrThrow = async (log: FastifyBaseLogger, rawToken: string | null): Promise<Principal> => {
    if (!isNil(rawToken) && rawToken.startsWith('Bearer sk-')) {
        // TYRBO-PATCH: `sk-` API keys were an EE feature; the service was
        // removed with packages/server/api/src/app/ee.
        throw new ActivepiecesError({
            code: ErrorCode.AUTHENTICATION,
            params: {
                message: 'API keys are not supported by this edition',
            },
        })
    }
    if (!isNil(rawToken) && rawToken.startsWith('Bearer ')) {
        const trimBearerPrefix = rawToken.replace('Bearer ', '')
        return accessTokenManager(log).verifyPrincipal(trimBearerPrefix)
    }
    return {
        id: nanoid(),
        type: PrincipalType.UNKNOWN,
    }
}

