import { isNil } from '@activepieces/core-utils'
import { ContextVersion } from '@activepieces/pieces-framework'
import { AppConnection, AppConnectionStatus, AppConnectionType, AppConnectionValue, ConnectionExpiredError, ConnectionLoadingError, ConnectionNotFoundError, ExecutionError, FetchError } from '@activepieces/shared'
import { utils } from '../utils'

export const createConnectionResolver = ({ projectId, engineToken, apiUrl, contextVersion }: CreateConnectionResolverParams): ConnectionResolver => {
    return {
        async obtain(externalId: string): Promise<AppConnectionValue> {
            const url = `${apiUrl}v1/worker/app-connections/${encodeURIComponent(externalId)}?projectId=${projectId}`

            const { data: connectionValue, error: connectionValueError } = await utils.tryCatchAndThrowOnEngineError((async () => {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${engineToken}`,
                    },
                })

                if (!response.ok) {
                    return handleResponseError({
                        externalId,
                        httpStatus: response.status,
                    })
                }
                const connection: AppConnection = await response.json()
                if (connection.status === AppConnectionStatus.ERROR) {
                    throw new ConnectionExpiredError(externalId)
                }
                // TYRBO-PATCH: inject the platform Trello API key at run time.
                return getConnectionValue(injectTrelloPlatformKey(connection), contextVersion)
            }))

            if (connectionValueError) {
                if (connectionValueError instanceof ExecutionError) {
                    throw connectionValueError
                }
                return handleFetchError({
                    url,
                    cause: connectionValueError,
                })
            }
            return connectionValue
        },
    }
}

// TYRBO-PATCH: Tyrbo-managed Trello connect. The forked Trello piece stores only
// a per-user token (CUSTOM_AUTH { token }); the single platform Power-Up API key
// lives in AP_TYRBO_TRELLO_API_KEY. Rewrite the connection into the BASIC_AUTH
// shape the piece reads at run time ({ username: <apiKey>, password: <token> }) —
// the same shape legacy BYO paste connections already carry, so a single code
// path serves both. No-op for every other piece, when the key is unset (BYO /
// non-Tyrbo deploys), or when the value is not CUSTOM_AUTH-with-token (legacy
// BASIC_AUTH connections pass straight through). Validation uses a separate
// server-side injection (executeValidateAuth bypasses this resolver).
const TRELLO_PIECE_NAME = '@activepieces/piece-trello'

const injectTrelloPlatformKey = (connection: AppConnection): AppConnection => {
    const apiKey = process.env.AP_TYRBO_TRELLO_API_KEY
    if (connection.pieceName !== TRELLO_PIECE_NAME || isNil(apiKey) || apiKey === '') {
        return connection
    }
    if (connection.value.type !== AppConnectionType.CUSTOM_AUTH) {
        return connection
    }
    const token = connection.value.props?.token
    if (isNil(token) || typeof token !== 'string' || token === '') {
        return connection
    }
    return {
        ...connection,
        type: AppConnectionType.BASIC_AUTH,
        value: {
            type: AppConnectionType.BASIC_AUTH,
            username: apiKey,
            password: token,
        },
    }
}

const handleResponseError = ({ externalId, httpStatus }: HandleResponseErrorParams): never => {
    if (httpStatus === 404) {
        throw new ConnectionNotFoundError(externalId)
    }

    throw new ConnectionLoadingError(externalId)
}

const handleFetchError = ({ url, cause }: HandleFetchErrorParams): never => {
    throw new FetchError(url, cause)
}

const getConnectionValue = (connection: AppConnection, contextVersion: ContextVersion | undefined): AppConnectionValue => {
    switch (contextVersion) {
        case undefined:
            return makeConnectionValueCompatibleWithContextV0(connection)
        case ContextVersion.V1:
            return connection.value
        default:
            return connection.value
    }
}

function makeConnectionValueCompatibleWithContextV0(connection: AppConnection): AppConnectionValue {
    switch (connection.value.type) {
        case AppConnectionType.SECRET_TEXT:
            return connection.value.secret_text as unknown as AppConnectionValue

        case AppConnectionType.CUSTOM_AUTH:
            return connection.value.props as unknown as AppConnectionValue
        default:
            return connection.value as unknown as AppConnectionValue
    }
}

type ConnectionResolver = {
    obtain(externalId: string): Promise<AppConnectionValue>
}

type CreateConnectionResolverParams = {
    projectId: string
    apiUrl: string
    engineToken: string
    contextVersion: ContextVersion | undefined
}

type HandleResponseErrorParams = {
    externalId: string
    httpStatus: number
}

type HandleFetchErrorParams = {
    url: string
    cause: unknown
}
