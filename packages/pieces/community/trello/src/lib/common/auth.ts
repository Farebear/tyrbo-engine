// TYRBO-PATCH: Tyrbo-managed Trello connect — auth bridge.
//
// The forked Trello piece stores only a per-user token (CUSTOM_AUTH { token }).
// The single platform Power-Up API key is injected server-side onto the resolved
// connection value as `username` (token becomes `password`) — at runtime by the
// app-connection worker controller, and for validation by the app-connection
// service. Legacy BYO paste connections are already BASIC_AUTH { username,
// password }. So every code path in this piece reads its credentials through this
// one bridge, which validates the resolved shape instead of casting it.
//
// The engine flattens a CUSTOM_AUTH value to its props for context V0 but keeps
// the full { type, props } for V1, and the validate() callback always receives
// flat props — so the bridge accepts the credentials at either the top level or
// under `props`.
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

const credsShape = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const trelloCredsSchema = z.union([
  credsShape,
  z.object({ props: credsShape }).transform((value) => value.props),
]);

export type TrelloCreds = { key: string; token: string };
