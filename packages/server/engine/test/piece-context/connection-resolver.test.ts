import { ContextVersion } from '@activepieces/pieces-framework'
import { AppConnectionStatus, AppConnectionType, ConnectionExpiredError, ConnectionLoadingError, ConnectionNotFoundError, FetchError } from '@activepieces/shared'
import { createConnectionResolver } from '../../src/lib/piece-context/connection-resolver'

const RESOLVER_PARAMS = {
    projectId: 'project-123',
    apiUrl: 'http://localhost:3000/',
    engineToken: 'test-token',
    contextVersion: ContextVersion.V1,
}

function makeConnection({ status = AppConnectionStatus.ACTIVE, type = AppConnectionType.SECRET_TEXT, value = { type: AppConnectionType.SECRET_TEXT, secret_text: 'my-secret' }, pieceName = '@activepieces/piece-example' }: {
    status?: AppConnectionStatus
    type?: AppConnectionType
    value?: Record<string, unknown>
    pieceName?: string
} = {}) {
    return {
        id: 'conn-1',
        name: 'my-connection',
        pieceName,
        status,
        value: { ...value, type },
    }
}

function mockFetchOnce(connection: unknown) {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
        JSON.stringify(connection),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
}

describe('connection-resolver service', () => {

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('V1 happy path returns connection.value', async () => {
        const connection = makeConnection()
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(connection),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual(connection.value)
    })

    it('V0 SECRET_TEXT returns connection.value.secret_text', async () => {
        const connection = makeConnection({
            type: AppConnectionType.SECRET_TEXT,
            value: { type: AppConnectionType.SECRET_TEXT, secret_text: 'my-secret' },
        })
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(connection),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))

        const resolver = createConnectionResolver({ ...RESOLVER_PARAMS, contextVersion: undefined })
        const result = await resolver.obtain('my-connection')

        expect(result).toBe('my-secret')
    })

    it('V0 CUSTOM_AUTH returns connection.value.props', async () => {
        const customProps = { apiKey: 'abc', domain: 'example.com' }
        const connection = makeConnection({
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: customProps },
        })
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(connection),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))

        const resolver = createConnectionResolver({ ...RESOLVER_PARAMS, contextVersion: undefined })
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual(customProps)
    })

    it('V0 other types returns connection.value', async () => {
        const connection = makeConnection({
            type: AppConnectionType.OAUTH2,
            value: { type: AppConnectionType.OAUTH2, access_token: 'tok' },
        })
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(connection),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))

        const resolver = createConnectionResolver({ ...RESOLVER_PARAMS, contextVersion: undefined })
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual(connection.value)
    })

    it('throws ConnectionNotFoundError on 404', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        await expect(resolver.obtain('missing')).rejects.toThrow(ConnectionNotFoundError)
    })

    it('throws ConnectionExpiredError when status is ERROR', async () => {
        const connection = makeConnection({ status: AppConnectionStatus.ERROR })
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
            JSON.stringify(connection),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        await expect(resolver.obtain('my-connection')).rejects.toThrow(ConnectionExpiredError)
    })

    it('throws ConnectionLoadingError on non-404 error', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        await expect(resolver.obtain('my-connection')).rejects.toThrow(ConnectionLoadingError)
    })

    it('throws FetchError on network failure', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        await expect(resolver.obtain('my-connection')).rejects.toThrow(FetchError)
    })
})

// TYRBO-PATCH: platform Trello API-key injection.
describe('connection-resolver Trello platform key injection', () => {
    const TRELLO = '@activepieces/piece-trello'
    const originalKey = process.env.AP_TYRBO_TRELLO_API_KEY

    beforeEach(() => {
        vi.restoreAllMocks()
        delete process.env.AP_TYRBO_TRELLO_API_KEY
    })

    afterEach(() => {
        if (originalKey === undefined) {
            delete process.env.AP_TYRBO_TRELLO_API_KEY
        }
        else {
            process.env.AP_TYRBO_TRELLO_API_KEY = originalKey
        }
    })

    it('rewrites a Trello CUSTOM_AUTH token into BASIC_AUTH { username: key, password: token }', async () => {
        process.env.AP_TYRBO_TRELLO_API_KEY = 'platform-key'
        mockFetchOnce(makeConnection({
            pieceName: TRELLO,
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } },
        }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({
            type: AppConnectionType.BASIC_AUTH,
            username: 'platform-key',
            password: 'user-token',
        })
    })

    it('exposes the injected key/token flattened for context V0 pieces', async () => {
        process.env.AP_TYRBO_TRELLO_API_KEY = 'platform-key'
        mockFetchOnce(makeConnection({
            pieceName: TRELLO,
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } },
        }))

        const resolver = createConnectionResolver({ ...RESOLVER_PARAMS, contextVersion: undefined })
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({
            type: AppConnectionType.BASIC_AUTH,
            username: 'platform-key',
            password: 'user-token',
        })
    })

    it('is a no-op when the platform key is unset (BYO falls through unchanged)', async () => {
        mockFetchOnce(makeConnection({
            pieceName: TRELLO,
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } },
        }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({ type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } })
    })

    it('does not touch connections for other pieces', async () => {
        process.env.AP_TYRBO_TRELLO_API_KEY = 'platform-key'
        mockFetchOnce(makeConnection({
            pieceName: '@activepieces/piece-slack',
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } },
        }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({ type: AppConnectionType.CUSTOM_AUTH, props: { token: 'user-token' } })
    })

    it('leaves a legacy Trello BASIC_AUTH (BYO key+token) paste connection untouched', async () => {
        process.env.AP_TYRBO_TRELLO_API_KEY = 'platform-key'
        mockFetchOnce(makeConnection({
            pieceName: TRELLO,
            type: AppConnectionType.BASIC_AUTH,
            value: { type: AppConnectionType.BASIC_AUTH, username: 'byo-key', password: 'byo-token' },
        }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({ type: AppConnectionType.BASIC_AUTH, username: 'byo-key', password: 'byo-token' })
    })

    it('is a no-op when the Trello CUSTOM_AUTH value has no token', async () => {
        process.env.AP_TYRBO_TRELLO_API_KEY = 'platform-key'
        mockFetchOnce(makeConnection({
            pieceName: TRELLO,
            type: AppConnectionType.CUSTOM_AUTH,
            value: { type: AppConnectionType.CUSTOM_AUTH, props: {} },
        }))

        const resolver = createConnectionResolver(RESOLVER_PARAMS)
        const result = await resolver.obtain('my-connection')

        expect(result).toEqual({ type: AppConnectionType.CUSTOM_AUTH, props: {} })
    })
})
