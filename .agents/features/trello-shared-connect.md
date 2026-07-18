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

This is effectively a **maintained fork of `packages/pieces/community/trello`**:
the auth model touches the piece pervasively, so every upstream Trello change
must be reconciled against these patches (all tagged `// TYRBO-PATCH`).

## Key Files
- `packages/pieces/community/trello/src/index.ts` — auth is `CUSTOM_AUTH` storing
  only `{ token }` (was `BasicAuth` key+token); `validate` reuses the injected key.
- `packages/pieces/community/trello/src/lib/common/auth.ts` — `toTrelloCreds()`,
  the single bridge that turns the resolved value into `{ key, token }`.
- `packages/pieces/community/trello/src/lib/common/index.ts` — dropdowns +
  webhook helpers read creds through the bridge.
- `packages/pieces/community/trello/src/lib/{actions,triggers}/**` — every call
  sources the key/token from the resolved value, not from a pasted key.
- `packages/server/engine/src/lib/piece-context/connection-resolver.ts` —
  **run-time** injection: rewrites a Trello `CUSTOM_AUTH { token }` connection to
  `BASIC_AUTH { username: <apiKey>, password: <token> }` (reads
  `process.env.AP_TYRBO_TRELLO_API_KEY`).
- `packages/server/api/src/app/tyrbo/tyrbo-trello-connect.ts` — **validation**
  injection (`injectTrelloValidationKey`) + `GET /v1/tyrbo/trello/authorize-url`.
- `packages/server/api/src/app/app-connection/app-connection-service/app-connection-service.ts`
  — calls `injectTrelloValidationKey` in `engineValidateAuth`.
- `packages/web/src/app/routes/redirect.tsx` — fragment-capture: reads `#token=`
  and `postMessage`s it to the opener.
- `packages/server/api/src/app/helper/system/system-props.ts` —
  `AppSystemProp.TYRBO_TRELLO_API_KEY`.

## The two injection points
`executeValidateAuth` does **not** go through the engine connection-resolver
(`piece-helper.ts`), so the key is injected in two places against one contract —
the piece always reads `{ username: <apiKey>, password: <token> }`:

| When | Where | Reads key from |
|---|---|---|
| Run time (actions, triggers, dropdowns) | engine `connection-resolver.ts` | `process.env.AP_TYRBO_TRELLO_API_KEY` |
| Connection validation | server `injectTrelloValidationKey` | `system.get(AppSystemProp.TYRBO_TRELLO_API_KEY)` |

Both read the **same** `AP_TYRBO_TRELLO_API_KEY` env var, so it must be set on
**both** the API and the worker/engine processes. Both are **no-ops when unset**:
existing legacy BYO `BASIC_AUTH` paste connections pass straight through at run
time, so non-Tyrbo deploys are unaffected. Creating a *new* Trello connection
without the key fails **loudly** (`injectTrelloValidationKey` throws
`INVALID_APP_CONNECTION`), never silently.

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
- `packages/server/engine/test/piece-context/connection-resolver.test.ts` —
  run-time injection: rewrites Trello `CUSTOM_AUTH` → `BASIC_AUTH`; no-op when key
  unset / other piece / legacy `BASIC_AUTH` / missing token.
- Authorize-URL endpoint + `injectTrelloValidationKey` — see the API test.
- QA smoke (`qa/run-piece-smoke.mjs trello`) still authenticates with
  `QA_TRELLO_API_KEY` + `QA_TRELLO_TOKEN` (the API key is the same Power-Up key;
  only the token differs per user).
