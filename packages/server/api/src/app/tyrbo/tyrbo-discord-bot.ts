// TYRBO-PATCH: shared platform Discord bot — server-side credential injection.
//
// Upstream's Discord piece makes every user paste their own bot token. Tyrbo runs
// ONE platform-owned bot: a user just adds it to their server and binds a connection
// to a guild id (the CUSTOM_AUTH props are `{ guildId, guildName? }` — no secret).
//
// The bot token never reaches the browser and is never persisted on the connection.
// It is injected into the resolved CUSTOM_AUTH props here, server-side, at the two
// points the piece needs it:
//   - connection resolve  (app-connection-worker-controller.ts) — runtime auth + the
//     channel/role dropdowns, both of which the engine resolves through that endpoint;
//   - connection validate (app-connection-service.ts)          — the piece's validate()
//     confirms the bot is actually in the bound guild.
//
// Injecting server-side (rather than reading the token in the sandboxed engine) keeps
// it zero-setup: the token stays in the API process env and travels only inside the
// discord connection value over the authenticated engine<->API channel, so self-hosters
// never have to add it to AP_SANDBOX_PROPAGATED_ENV_VARS.
//
// Every entry point is a no-op unless the piece is discord, the stored value is
// CUSTOM_AUTH, and AP_TYRBO_DISCORD_BOT_TOKEN is set — so existing pasted SECRET_TEXT
// connections and non-Tyrbo deployments are left exactly as-is.
import { isNil } from '@activepieces/core-utils'
import { AppConnectionType, AppConnectionValue } from '@activepieces/shared'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'

function readEnv(prop: AppSystemProp): string | undefined {
    const value = system.get(prop)
    return isNil(value) || value === '' ? undefined : value
}

function injectDiscordBotCredentials({ pieceName, value, includeClientId }: InjectParams): AppConnectionValue {
    const token = readEnv(AppSystemProp.TYRBO_DISCORD_BOT_TOKEN)
    if (pieceName !== DISCORD_PIECE_NAME || isNil(token) || value.type !== AppConnectionType.CUSTOM_AUTH) {
        return value
    }
    const clientId = includeClientId ? readEnv(AppSystemProp.TYRBO_DISCORD_CLIENT_ID) : undefined
    return {
        ...value,
        props: {
            ...value.props,
            secret_text: token,
            ...(isNil(clientId) ? {} : { clientId }),
        },
    }
}

export const tyrboDiscordBot = {
    // Runtime + dropdown resolve: actions and guild/channel/role enumeration only need
    // the bot token merged onto the connection's guild binding.
    injectForRuntime(params: RuntimeInjectParams): AppConnectionValue {
        return injectDiscordBotCredentials({ ...params, includeClientId: false })
    },
    // Connection validate: additionally exposes the public client id so the piece's
    // validate() can build the "add the bot to your server" install URL it returns when
    // the bot is not yet a member of the bound guild.
    injectForValidation(params: RuntimeInjectParams): AppConnectionValue {
        return injectDiscordBotCredentials({ ...params, includeClientId: true })
    },
    isEnabled(): boolean {
        return !isNil(readEnv(AppSystemProp.TYRBO_DISCORD_BOT_TOKEN))
    },
}

export const DISCORD_PIECE_NAME = '@activepieces/piece-discord'

type RuntimeInjectParams = {
    pieceName: string
    value: AppConnectionValue
}

type InjectParams = RuntimeInjectParams & {
    includeClientId: boolean
}
