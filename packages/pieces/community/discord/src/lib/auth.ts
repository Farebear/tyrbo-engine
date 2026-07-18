// TYRBO-PATCH: shared Tyrbo bot — the connection binds to a guild, not a token.
//
// Upstream: PieceAuth.SecretText where each user pastes their own bot token. Fork: one
// platform-owned bot, so the user only tells us WHICH server it should act on. The bot
// token is injected server-side at resolve/validate time (see the API's
// tyrbo-discord-bot.ts) and is never entered or stored here.
import { HttpError, HttpMethod, httpClient } from '@activepieces/pieces-common';
import { PieceAuth, Property } from '@activepieces/pieces-framework';
import { discordBotAuth } from './common/bot-auth';

const markdown = `
This uses the shared **Tyrbo Discord bot** — you don't need to create a bot or paste a token.

1. Add the Tyrbo bot to your server using the invite link your administrator provided.
2. In Discord, enable **Settings → Advanced → Developer Mode**.
3. Right-click your server's icon → **Copy Server ID** and paste it below.

We'll verify the bot is actually in that server before saving.
`;

function buildInstallUrl(clientId: string): string {
    // Mirrors the portal's "Add to Server" URL (bot + slash-command scopes). Permissions
    // are Administrator (8) for now — to be scoped down when the bot's needs are finalised.
    const params = new URLSearchParams({
        client_id: clientId,
        scope: 'bot applications.commands',
        permissions: '8',
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const discordAuth = PieceAuth.CustomAuth({
    displayName: 'Discord Server',
    description: markdown,
    required: true,
    props: {
        guildId: Property.ShortText({
            displayName: 'Server (Guild) ID',
            description: 'The ID of the Discord server the Tyrbo bot should act on.',
            required: true,
        }),
        guildName: Property.ShortText({
            displayName: 'Server Name',
            description: 'Optional label for this server, shown in dropdowns.',
            required: false,
        }),
    },
    validate: async ({ auth }) => {
        const resolved = tryResolve(auth);
        if (resolved === undefined) {
            return {
                valid: false,
                error: 'The Discord bot is not configured on this instance. Set AP_TYRBO_DISCORD_BOT_TOKEN (self-hosted) or contact your administrator.',
            };
        }
        try {
            await httpClient.sendRequest({
                method: HttpMethod.GET,
                url: `https://discord.com/api/v10/guilds/${resolved.guildId}`,
                headers: { Authorization: `Bot ${resolved.secretText}` },
            });
            return { valid: true };
        }
        catch (error) {
            const status = error instanceof HttpError ? error.response.status : undefined;
            if (status === 401) {
                return { valid: false, error: 'The configured Discord bot token is invalid. Contact your administrator.' };
            }
            const installHint = resolved.clientId !== undefined
                ? ` Add it here: ${buildInstallUrl(resolved.clientId)}`
                : '';
            return {
                valid: false,
                error: `The Discord bot isn't in that server, or the Server ID is wrong.${installHint} Then save again.`,
            };
        }
    },
});

function tryResolve(auth: unknown): ReturnType<typeof discordBotAuth.resolve> | undefined {
    try {
        return discordBotAuth.resolve(auth);
    }
    catch {
        return undefined;
    }
}
