import { AppConnectionType, AppConnectionValue } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISCORD_PIECE_NAME, tyrboDiscordBot } from '../../../../src/app/tyrbo/tyrbo-discord-bot'

const ENV_KEYS = ['AP_TYRBO_DISCORD_BOT_TOKEN', 'AP_TYRBO_DISCORD_CLIENT_ID']

const OTHER_PIECE = '@activepieces/piece-slack'

function guildBinding(): AppConnectionValue {
    return {
        type: AppConnectionType.CUSTOM_AUTH,
        props: { guildId: 'guild-a', guildName: 'Guild A' },
    }
}

function pastedToken(): AppConnectionValue {
    return {
        type: AppConnectionType.SECRET_TEXT,
        secret_text: 'user-pasted-token',
    }
}

describe('tyrboDiscordBot', () => {
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

    it('injects the platform bot token onto a discord guild binding at resolve time', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'

        const result = tyrboDiscordBot.injectForRuntime({
            pieceName: DISCORD_PIECE_NAME,
            value: guildBinding(),
        })

        expect(result).toEqual({
            type: AppConnectionType.CUSTOM_AUTH,
            props: { guildId: 'guild-a', guildName: 'Guild A', secret_text: 'platform-bot-token' },
        })
    })

    it('does not leak the public client id into the runtime auth', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        process.env.AP_TYRBO_DISCORD_CLIENT_ID = 'client-id'

        const result = tyrboDiscordBot.injectForRuntime({
            pieceName: DISCORD_PIECE_NAME,
            value: guildBinding(),
        })

        expect(result.type).toBe(AppConnectionType.CUSTOM_AUTH)
        if (result.type === AppConnectionType.CUSTOM_AUTH) {
            expect(result.props).not.toHaveProperty('clientId')
        }
    })

    it('additionally injects the client id at validate time (for the install URL)', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        process.env.AP_TYRBO_DISCORD_CLIENT_ID = 'client-id'

        const result = tyrboDiscordBot.injectForValidation({
            pieceName: DISCORD_PIECE_NAME,
            value: guildBinding(),
        })

        expect(result).toEqual({
            type: AppConnectionType.CUSTOM_AUTH,
            props: {
                guildId: 'guild-a',
                guildName: 'Guild A',
                secret_text: 'platform-bot-token',
                clientId: 'client-id',
            },
        })
    })

    it('omits the client id at validate time when it is not configured', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'

        const result = tyrboDiscordBot.injectForValidation({
            pieceName: DISCORD_PIECE_NAME,
            value: guildBinding(),
        })

        if (result.type === AppConnectionType.CUSTOM_AUTH) {
            expect(result.props).not.toHaveProperty('clientId')
            expect(result.props.secret_text).toBe('platform-bot-token')
        }
    })

    it('is a no-op when the platform bot token is unset (BYO / non-Tyrbo deployment)', () => {
        const value = guildBinding()

        const result = tyrboDiscordBot.injectForRuntime({ pieceName: DISCORD_PIECE_NAME, value })

        expect(result).toEqual(value)
        if (result.type === AppConnectionType.CUSTOM_AUTH) {
            expect(result.props).not.toHaveProperty('secret_text')
        }
    })

    it('never touches connections for other pieces', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        const value = guildBinding()

        const result = tyrboDiscordBot.injectForRuntime({ pieceName: OTHER_PIECE, value })

        expect(result).toEqual(value)
        if (result.type === AppConnectionType.CUSTOM_AUTH) {
            expect(result.props).not.toHaveProperty('secret_text')
        }
    })

    it('leaves an existing pasted SECRET_TEXT discord connection untouched', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        const value = pastedToken()

        const result = tyrboDiscordBot.injectForRuntime({ pieceName: DISCORD_PIECE_NAME, value })

        expect(result).toEqual(value)
    })

    it('does not mutate the connection value it is given', () => {
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        const value = guildBinding()

        tyrboDiscordBot.injectForRuntime({ pieceName: DISCORD_PIECE_NAME, value })

        expect(value).toEqual({
            type: AppConnectionType.CUSTOM_AUTH,
            props: { guildId: 'guild-a', guildName: 'Guild A' },
        })
    })

    it('reports whether the shared bot is enabled', () => {
        expect(tyrboDiscordBot.isEnabled()).toBe(false)
        process.env.AP_TYRBO_DISCORD_BOT_TOKEN = 'platform-bot-token'
        expect(tyrboDiscordBot.isEnabled()).toBe(true)
    })
})
