# Discord Shared Bot (Tyrbo fork)

## Summary
Upstream's Discord piece makes every user create a Discord application and paste their own **bot token**. Tyrbo instead runs **one platform-owned Discord bot**: the operator sets the bot token once as an engine env secret, and each user just adds the Tyrbo bot to their server and binds a connection to a **guild id**. No token is ever entered by, shown to, or stored for the user.

This is a **maintained fork** of `packages/pieces/community/discord` — the change touches auth, every action, both triggers, and the common dropdowns, so upstream merges into that piece will carry an ongoing conflict cost. Every fork edit is tagged `// TYRBO-PATCH` (grep for it).

## Design (Path A — platform token + per-connection guild binding)
- A connection stores only `{ guildId, guildName? }` (a `CUSTOM_AUTH`) — **no secret**.
- The bot token lives as `AP_TYRBO_DISCORD_BOT_TOKEN` and is injected **server-side** into the resolved connection value, never read in the sandboxed engine.
- All guild/channel/role enumeration is scoped to `connection.guildId`. The upstream `GET /users/@me/guilds` fan-out is removed — with a shared token it would list **every tenant's** servers.

## Why server-side injection (not the engine)
The spec first suggested injecting in the engine's `connection-resolver.ts`. That runs in the sandboxed engine process, which only receives env vars whitelisted in `AP_SANDBOX_PROPAGATED_ENV_VARS` (see `packages/server/sandbox/.../create-sandbox-for-job.ts`). Reading the token there would be **silently broken** until someone edits that Fly whitelist — violating the zero-setup self-hosting rule. Both runtime `context.auth` and the builder's channel/role dropdowns resolve through the **worker app-connections endpoint**, where `system.get(AppSystemProp…)` is available, so injection lives there instead. The engine resolver stays generic.

## Token / credential flow
1. `GET /v1/worker/app-connections/:externalId` (`app-connection-worker-controller.ts`) resolves the stored value, then calls `tyrboDiscordBot.injectForRuntime(...)` → merges `secret_text` into the `CUSTOM_AUTH` props. This one endpoint feeds **both** runtime auth and dropdown `options({ auth })`.
2. On connection save, `validateConnectionValue` (`app-connection-service.ts`) passes `tyrboDiscordBot.injectForValidation(...)` (token **+** public client id) to the engine's `EXECUTE_VALIDATION`, in a throwaway copy — the persisted value never carries the token. The piece's `validate()` confirms the bot is a member of the bound guild (`GET /guilds/{id}`) and, on failure, returns the "add the bot" install URL built from the client id.
3. The piece reads the injected fields through `discordBotAuth.resolve(auth)` (`common/bot-auth.ts`), a dependency-free guard that accepts both the `{ type, props }` runtime shape and the flat `validate()` shape (no `as` cast — `unknown` + type guards).

## Key Files
- `packages/server/api/src/app/tyrbo/tyrbo-discord-bot.ts` — the injector (`injectForRuntime` / `injectForValidation` / `isEnabled`). No-op unless piece is discord, value is `CUSTOM_AUTH`, and the token is set.
- `packages/server/api/src/app/app-connection/app-connection-worker-controller.ts` — runtime/dropdown injection call.
- `packages/server/api/src/app/app-connection/app-connection-service/app-connection-service.ts` — validate-time injection (non-persisted).
- `packages/server/api/src/app/helper/system/system-props.ts` — `TYRBO_DISCORD_BOT_TOKEN`, `TYRBO_DISCORD_CLIENT_ID`. Registered in `helper/system-validator.ts`.
- `packages/pieces/community/discord/src/lib/common/bot-auth.ts` — the auth guard + resolved-value type.
- `packages/pieces/community/discord/src/lib/auth.ts` — `CUSTOM_AUTH { guildId, guildName? }` + membership `validate()`.
- `packages/pieces/community/discord/src/lib/common/index.ts` — channel/roles dropdowns scoped to `auth.guildId`.
- `packages/pieces/community/discord/src/index.ts` — `createCustomApiCallAction` **removed** (a raw shared-token escape hatch = cross-tenant hole).

## Config (AppSystemProp → env)
| Prop | Env var | Purpose |
|---|---|---|
| `TYRBO_DISCORD_BOT_TOKEN` | `AP_TYRBO_DISCORD_BOT_TOKEN` | The shared bot token, injected server-side. Unset ⇒ every injection is a no-op (BYO / non-Tyrbo deployments unaffected). |
| `TYRBO_DISCORD_CLIENT_ID` | `AP_TYRBO_DISCORD_CLIENT_ID` | Public application id; builds the bot install URL. Also the seam for the guild-capture redirect flow (below). |

Credentials live in the monorepo root `.env` (`DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_CLIENT_SECRET`). They are **not** wired to Fly yet — credential wiring happens after review.

## Guild capture
- **(a) implemented — paste the Server ID.** The user pastes their guild id; `validate()` confirms the Tyrbo bot is actually a member before saving, and returns the install URL when it is not.
- **(b) noted — bot-install redirect.** Automatic capture via the `bot`-scope install redirect (`code` → guild id) is left as a clean seam: `AP_TYRBO_DISCORD_CLIENT_ID` + redirect URI `{AP_FRONTEND_URL}/redirect` are already in place; only the redirect handler + connect UI remain.

## Tenancy
The guild id always comes from the connection (`discordBotAuth.resolve`), never a user-editable prop — the upstream `guild_id` inputs were removed from all 10 guild actions and the `new-member` trigger, and the `discordCommon.guilds` picker and `createCustomApiCallAction` were deleted. So a connection bound to guild A cannot enumerate or act on guild B.

## Tests
- `test/unit/app/tyrbo/tyrbo-discord-bot.test.ts` — the injector adds the token for discord `CUSTOM_AUTH` only; no-op for other pieces, unset token, and existing `SECRET_TEXT` (pasted) connections; immutable.
- `packages/pieces/community/discord/src/lib/common/bot-auth.test.ts` — guard dual-shape resolution + rejection, and a source scan asserting the piece never calls `/users/@me/guilds` and never reads a guild from a user prop.
- `packages/pieces/community/discord/src/lib/common/tenancy.test.ts` — dropdowns hit `/guilds/{connection guild}/…` with the injected token; a guild-B connection can't reach guild A.

## Notes
- **Open decision — fork-in-place vs a separate `piece-discord-tyrbo`.** This PR forks in place (smallest connection/flow disruption; upstream merge cost accepted). A separate piece would isolate the fork but split the action surface.
- Existing pasted `SECRET_TEXT` discord connections keep resolving unchanged (injection is a no-op for them); already-built flows run as before. The `send-message-webhook` action (no bot token) is untouched — the zero-setup alternative.
- The install URL is built with Administrator permissions (`permissions=8`) to mirror the portal setup; scope down later.
