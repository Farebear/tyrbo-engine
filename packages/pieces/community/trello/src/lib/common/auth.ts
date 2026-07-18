// TYRBO-PATCH: Tyrbo-managed Trello connect — auth bridge.
//
// The forked Trello piece stores only a per-user token (CUSTOM_AUTH { token }).
// The single platform Power-Up API key is injected as the BASIC_AUTH `username`
// (token becomes `password`) — at run time by the engine connection-resolver, and
// for validation by the server (tyrbo-trello-connect.ts). Legacy BYO paste
// connections are already BASIC_AUTH { username, password }. So every code path
// in this piece reads its credentials through this one bridge, which validates
// the resolved shape instead of casting it.
import { z } from 'zod';

export function toTrelloCreds(auth: unknown): TrelloCreds {
  const parsed = trelloCredsSchema.safeParse(auth);
  if (!parsed.success) {
    throw new Error(
      'Trello connection is missing its API key or token. Reconnect the Trello connection.',
    );
  }
  return { key: parsed.data.username, token: parsed.data.password };
}

const trelloCredsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type TrelloCreds = { key: string; token: string };
