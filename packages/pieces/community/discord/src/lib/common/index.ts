// TYRBO-PATCH: every dropdown is scoped to the connection's bound guild.
//
// Upstream fanned out over GET /users/@me/guilds and then listed each guild's channels —
// with a shared bot token that would enumerate EVERY tenant's servers. The fork drops
// that call entirely: the guild id comes from the connection (discordBotAuth.resolve),
// and channels/roles are read directly from that one guild.
import { HttpMethod, httpClient } from '@activepieces/pieces-common';
import { Channel, Role } from '../common/models';
import { Property } from '@activepieces/pieces-framework';
import { discordAuth } from '../auth';
import { discordBotAuth, DiscordBotAuth } from './bot-auth';

export interface Member {
  user: {
    id: string;
    username: string;
  };
}

function disabledDropdown(placeholder: string) {
  return { disabled: true, options: [] as { value: string; label: string }[], placeholder };
}

export const discordCommon = {
  channel: Property.Dropdown({
    auth: discordAuth,
    displayName: 'Channel',
    description: 'List of channels',
    required: true,
    refreshers: [],
    options: async ({ auth }) => {
      if (!auth) {
        return disabledDropdown('Please connect your Discord bot first');
      }

      let resolved: DiscordBotAuth;
      try {
        resolved = discordBotAuth.resolve(auth);
      } catch (error) {
        return disabledDropdown(error instanceof Error ? error.message : 'Reconnect the Discord bot');
      }

      const res = await httpClient.sendRequest<Channel[]>({
        method: HttpMethod.GET,
        url: `https://discord.com/api/v9/guilds/${resolved.guildId}/channels`,
        headers: { Authorization: 'Bot ' + resolved.secretText },
      });

      if (res.body.length === 0) {
        return disabledDropdown('No channels found — is the Tyrbo bot in this server?');
      }

      return {
        options: res.body.map((channel) => ({
          value: channel.id,
          label: channel.name,
        })),
      };
    },
  }),
  roles: Property.Dropdown({
    auth: discordAuth,
    displayName: 'Roles',
    description: 'List of roles',
    required: true,
    refreshers: [],
    options: async ({ auth }) => {
      if (!auth) {
        return disabledDropdown('Please connect your Discord bot first');
      }

      let resolved: DiscordBotAuth;
      try {
        resolved = discordBotAuth.resolve(auth);
      } catch (error) {
        return disabledDropdown(error instanceof Error ? error.message : 'Reconnect the Discord bot');
      }

      const res = await httpClient.sendRequest<Role[]>({
        method: HttpMethod.GET,
        url: `https://discord.com/api/v9/guilds/${resolved.guildId}/roles`,
        headers: { Authorization: 'Bot ' + resolved.secretText },
      });

      if (res.body.length === 0) {
        return disabledDropdown('No roles found in this server');
      }

      return {
        options: res.body.map((role) => ({
          value: role.id,
          label: role.name,
        })),
      };
    },
  }),
  resolveAuth: discordBotAuth.resolve,
};
