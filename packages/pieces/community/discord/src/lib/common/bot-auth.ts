// TYRBO-PATCH: shared Tyrbo bot — read the server-injected connection value.
//
// Upstream stored the bot token as the user-entered SecretText auth. In the Tyrbo fork
// a connection stores only its guild binding ({ guildId, guildName? }); the ONE platform
// bot token is injected into the CUSTOM_AUTH props server-side (see the API's
// tyrbo-discord-bot.ts) and is therefore NOT part of the declared auth props type.
//
// Two runtime shapes reach the piece, so this guard accepts either (no `as` cast):
//   - actions / triggers / dropdowns : { type: 'CUSTOM_AUTH', props: { guildId, secret_text, ... } }
//   - the auth validate() callback   : { guildId, secret_text, ... }   (props already unwrapped)
//
// Every guild/channel/role call in this piece derives its guild id from here, never from a
// user-supplied prop — that per-connection scoping is what keeps one tenant's shared-bot
// connection from reaching another tenant's servers.

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveDiscordBotAuth(auth: unknown): DiscordBotAuth {
    const props = isRecord(auth) && isRecord(auth['props']) ? auth['props'] : auth;
    if (!isRecord(props)) {
        throw new Error(DISCORD_CONNECTION_ERROR);
    }
    const secretText = readString(props, 'secret_text');
    const guildId = readString(props, 'guildId');
    if (secretText === undefined || guildId === undefined) {
        throw new Error(DISCORD_CONNECTION_ERROR);
    }
    return {
        secretText,
        guildId,
        guildName: readString(props, 'guildName'),
        clientId: readString(props, 'clientId'),
    };
}

export const DISCORD_CONNECTION_ERROR =
    'This Discord connection is missing its bot token or server ID. Reconnect the Discord bot for this server.';

export const discordBotAuth = {
    resolve: resolveDiscordBotAuth,
};

export type DiscordBotAuth = {
    secretText: string;
    guildId: string;
    guildName?: string;
    clientId?: string;
};
