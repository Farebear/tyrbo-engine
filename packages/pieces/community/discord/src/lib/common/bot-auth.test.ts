import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCORD_CONNECTION_ERROR, discordBotAuth } from './bot-auth';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Match the endpoint only where it is an actual request URL (…discord.com/api/vN/users/@me/guilds),
// not where a TYRBO-PATCH comment mentions the removed call by name.
const ACCOUNT_WIDE_GUILDS_CALL = /discord\.com\/api\/v\d+\/users\/@me\/guilds/;

function readAllSource(dir: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllSource(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push({ file: full, content: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('discordBotAuth.resolve', () => {
  it('reads the runtime shape ({ type, props }) actions and dropdowns receive', () => {
    const resolved = discordBotAuth.resolve({
      type: 'CUSTOM_AUTH',
      props: { guildId: 'guild-a', guildName: 'Guild A', secret_text: 'bot-token', clientId: 'client-id' },
    });

    expect(resolved).toEqual({
      secretText: 'bot-token',
      guildId: 'guild-a',
      guildName: 'Guild A',
      clientId: 'client-id',
    });
  });

  it('reads the flat shape the validate() callback receives', () => {
    const resolved = discordBotAuth.resolve({ guildId: 'guild-a', secret_text: 'bot-token' });

    expect(resolved).toEqual({
      secretText: 'bot-token',
      guildId: 'guild-a',
      guildName: undefined,
      clientId: undefined,
    });
  });

  it('rejects a connection with no injected token', () => {
    expect(() => discordBotAuth.resolve({ type: 'CUSTOM_AUTH', props: { guildId: 'guild-a' } })).toThrow(
      DISCORD_CONNECTION_ERROR
    );
  });

  it('rejects a connection with no guild id', () => {
    expect(() => discordBotAuth.resolve({ secret_text: 'bot-token' })).toThrow(DISCORD_CONNECTION_ERROR);
  });

  it('treats empty strings as missing', () => {
    expect(() => discordBotAuth.resolve({ guildId: '', secret_text: 'bot-token' })).toThrow(DISCORD_CONNECTION_ERROR);
  });

  it('rejects non-object auth values', () => {
    expect(() => discordBotAuth.resolve(undefined)).toThrow(DISCORD_CONNECTION_ERROR);
    expect(() => discordBotAuth.resolve('a-token')).toThrow(DISCORD_CONNECTION_ERROR);
  });
});

describe('tenancy: no cross-guild enumeration in the piece source', () => {
  const sources = readAllSource(srcDir);

  it('never calls GET /users/@me/guilds (which would list every tenant\'s servers)', () => {
    const offenders = sources
      .filter((s) => ACCOUNT_WIDE_GUILDS_CALL.test(s.content))
      .map((s) => path.relative(srcDir, s.file));

    expect(offenders).toEqual([]);
  });

  it('never derives a guild from a user-supplied prop (guild comes from the connection)', () => {
    const offenders = sources
      .filter((s) => s.content.includes('propsValue.guild_id') || s.content.includes('discordCommon.guilds'))
      .map((s) => path.relative(srcDir, s.file));

    expect(offenders).toEqual([]);
  });
});
