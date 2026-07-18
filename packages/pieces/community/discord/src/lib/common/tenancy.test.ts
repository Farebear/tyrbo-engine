import { HttpRequest, HttpResponse, httpClient } from '@activepieces/pieces-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordCommon } from './index';

// The runtime shape the engine hands the piece after the API injects the platform
// bot token into the connection's CUSTOM_AUTH props (see tyrbo-discord-bot.ts).
function connectionBoundTo(guildId: string): unknown {
  return {
    type: 'CUSTOM_AUTH',
    props: { guildId, guildName: `Name of ${guildId}`, secret_text: 'platform-bot-token' },
  };
}

function resp(body: unknown): HttpResponse {
  return { status: 200, headers: {}, body };
}

type ChannelOptions = typeof discordCommon.channel.options;
const ctx = {} as unknown as Parameters<ChannelOptions>[1];

function optionsArg(auth: unknown): Parameters<ChannelOptions>[0] {
  return { auth } as unknown as Parameters<ChannelOptions>[0];
}

function spySendRequest() {
  return vi.spyOn(httpClient, 'sendRequest');
}

let sendRequest: ReturnType<typeof spySendRequest>;

beforeEach(() => {
  sendRequest = spySendRequest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discordCommon dropdowns are scoped to the connection guild', () => {
  it('lists channels from the bound guild only, with the injected bot token', async () => {
    sendRequest.mockResolvedValue(resp([{ id: 'c1', name: 'general' }]));

    const result = await discordCommon.channel.options(optionsArg(connectionBoundTo('guild-a')), ctx);

    const req = sendRequest.mock.calls[0][0] as HttpRequest;
    expect(req.url).toBe('https://discord.com/api/v9/guilds/guild-a/channels');
    expect(req.headers?.['Authorization']).toBe('Bot platform-bot-token');
    expect(result).toMatchObject({ options: [{ value: 'c1', label: 'general' }] });
  });

  it('lists roles from the bound guild only', async () => {
    sendRequest.mockResolvedValue(resp([{ id: 'r1', name: 'admin' }]));

    await discordCommon.roles.options(optionsArg(connectionBoundTo('guild-a')), ctx);

    const req = sendRequest.mock.calls[0][0] as HttpRequest;
    expect(req.url).toBe('https://discord.com/api/v9/guilds/guild-a/roles');
  });

  it('a connection bound to guild B can never reach guild A', async () => {
    sendRequest.mockResolvedValue(resp([{ id: 'c9', name: 'private' }]));

    await discordCommon.channel.options(optionsArg(connectionBoundTo('guild-b')), ctx);

    const urls = sendRequest.mock.calls.map((call) => (call[0] as HttpRequest).url);
    expect(urls).toEqual(['https://discord.com/api/v9/guilds/guild-b/channels']);
    expect(urls.every((url) => !url.includes('guild-a'))).toBe(true);
    expect(urls.every((url) => !url.includes('/users/@me/guilds'))).toBe(true);
  });

  it('shows a disabled placeholder instead of calling Discord when the connection is unusable', async () => {
    const result = await discordCommon.channel.options(optionsArg({ type: 'CUSTOM_AUTH', props: { guildId: 'guild-a' } }), ctx);

    expect(sendRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ disabled: true });
  });
});
