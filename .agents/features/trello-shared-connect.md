# Trello Shared Connect (Tyrbo-managed)

## Summary
`// TYRBO-PATCH`. Upstream Trello is a two-value paste: the user enters both an
API Key and a Token. Tyrbo replaces this with a **one platform-owned API key +
per-user token** model: Tyrbo holds a single Trello Power-Up API key
(`AP_TYRBO_TRELLO_API_KEY`), each user approves via Trello's authorize flow to
mint a per-user token, and the connection stores **only that token**. The API
key is injected server-side so the piece never sees it entered by a user.

Unlike a shared-bot model (e.g. Discord), **no tenant scoping is needed** — a
Trello token only ever accesses its own user's boards, so the platform key +
per-user token is safe without per-project isolation on the token.

This is a **maintained fork of `packages/pieces/community/trello`**: the auth
model touches the piece pervasively, so every upstream Trello change must be
reconciled against these patches (all tagged `// TYRBO-PATCH`). It is a sibling
of the Discord shared-bot patch and follows the same server-side injection
pattern — see `.agents/features/discord-shared-bot.md` and
`[[tyrbo-shared-credential-injection]]`.

## Where the key is injected (server-side, NOT the engine)
The engine runs in a sandboxed child process whose env is the
`AP_SANDBOX_PROPAGATED_ENV_VARS` allowlist (`create-sandbox-for-job.ts`), so
`process.env.AP_TYRBO_TRELLO_API_KEY` reads there are empty. The key is therefore
injected **server-side**, where `system.get(AppSystemProp.TYRBO_TRELLO_API_KEY)`
works, at the two points the piece needs it — both merge the key onto the
resolved `CUSTOM_AUTH` props as `username` (token → `password`):

| When | Where | Injection |
|---|---|---|
| Runtime auth + board/list/label dropdowns | `app-connection-worker-controller.ts` (`GET /:externalId`) | `injectTrelloPlatformKey(...)` |
| Connection validation | `app-connection-service.ts` `engineValidateAuth` caller | `injectTrelloPlatformKey(...)` |

Both are **no-ops** unless the piece is trello, the value is `CUSTOM_AUTH` with a
token, and the key is set — so legacy pasted `BASIC_AUTH` connections and
non-Tyrbo deployments are untouched, and the injected secret is never persisted
(it rides only the resolved value over the authenticated engine↔API channel).

## The auth bridge (`common/auth.ts`)
`toTrelloCreds(auth)` is the single point the piece reads credentials, validating
the resolved shape with Zod (no casts). It accepts the key/token at either the
top level *or* under `props`, because the engine flattens a `CUSTOM_AUTH` value to
its props for context V0 but keeps the full `{ type, props }` for V1, and the
`validate()` callback always receives flat props. Legacy BYO `BASIC_AUTH`
connections (`{ username, password }`) resolve through the same bridge.

## Key Files
- `packages/pieces/community/trello/src/index.ts` — auth is `CUSTOM_AUTH` storing
  only `{ token }` (was `BasicAuth` key+token); `validate` lists boards with the
  injected key.
- `packages/pieces/community/trello/src/lib/common/auth.ts` — `toTrelloCreds()`.
- `packages/pieces/community/trello/src/lib/common/index.ts`,
  `src/lib/{actions,triggers}/**` — every call reads creds through the bridge.
- `packages/server/api/src/app/tyrbo/tyrbo-trello-connect.ts` —
  `injectTrelloPlatformKey` + `GET /v1/tyrbo/trello/authorize-url`.
- `packages/server/api/src/app/app-connection/app-connection-worker-controller.ts`
  — runtime injection (composed with the Discord injection).
- `packages/server/api/src/app/app-connection/app-connection-service/app-connection-service.ts`
  — validation injection.
- `packages/server/api/src/app/helper/system/system-props.ts` +
  `helper/system-validator.ts` — `AppSystemProp.TYRBO_TRELLO_API_KEY` (+ its
  required validator entry).
- `packages/web/src/app/routes/redirect.tsx` — fragment-capture: reads `#token=`
  and `postMessage`s it to the opener.

`AP_TYRBO_TRELLO_API_KEY` only needs to be set on the **API** process env (never
the worker/engine, never `AP_SANDBOX_PROPAGATED_ENV_VARS`).

## Token capture (fragment flow)
1. Product Connect flow calls `GET /v1/tyrbo/trello/authorize-url` →
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=<platform>&key=<apiKey>&return_url=<AP_FRONTEND_URL>/redirect&callback_method=fragment`.
   `return_url` is pinned to this instance's own `AP_FRONTEND_URL` (never
   caller-supplied) so the token can only return to us. `scope=read,write` only
   — never `account` (least privilege). `name` is the platform name (white-label).
2. User authorizes on Trello → redirected to `{AP_FRONTEND_URL}/redirect#token=…`.
3. `redirect.tsx` reads the fragment and `postMessage`s `{ token }` to the opener.
4. The Connect flow stores `CUSTOM_AUTH { token }`.

## Open decisions (surfaced in the PR)
- **Fragment-capture (chosen) vs OAuth 1.0a 3-legged.** Fragment-capture keeps the
  server code minimal; OAuth1 avoids a client-side return page but is much more code.
- **Fork-in-place (chosen) vs a separate `piece-trello-tyrbo`.** In-place keeps one
  Trello piece but makes upstream merges a manual reconcile; a separate piece
  isolates the fork at the cost of duplicating all actions/triggers.
- **Frontend Connect-button wiring** (open popup → receive `{ token }` → upsert
  `{ token }`) lives in the Tyrbo product frontend (`app.tyrbo.ai`); `redirect.tsx`
  here is already fragment-ready for staging/local. As a zero-frontend fallback the
  token field accepts a pasted token.

## Tests
- `packages/pieces/community/trello/src/lib/common/auth.test.ts` — `toTrelloCreds`
  across both context shapes (flat props / `{ type, props }`), legacy `BASIC_AUTH`,
  and the missing/empty/non-object failure cases.
- QA smoke (`qa/run-piece-smoke.mjs trello`) authenticates with `QA_TRELLO_API_KEY`
  (same Power-Up key, set as `AP_TYRBO_TRELLO_API_KEY`) + `QA_TRELLO_TOKEN`; it must
  create a `CUSTOM_AUTH { token }` connection (a legacy `BASIC_AUTH` value no longer
  passes connect-time validation against the `CUSTOM_AUTH` piece).
