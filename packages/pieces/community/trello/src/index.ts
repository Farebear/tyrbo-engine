import {
  HttpMethod,
  HttpRequest,
  createCustomApiCallAction,
  httpClient,
} from '@activepieces/pieces-common';
import { PieceAuth, createPiece } from '@activepieces/pieces-framework';
import { PieceCategory } from '@activepieces/pieces-framework';
import { createCard } from './lib/actions/card/create-card';
import { getCard } from './lib/actions/card/get-card';
import { updateCard } from './lib/actions/card/update-card';
import { deleteCard } from './lib/actions/card/delete-card';
import { getCardAttachments } from './lib/actions/card-attachment/get-card-attachments';
import { addCardAttachment } from './lib/actions/card-attachment/add-card-attachment';
import { getCardAttachment } from './lib/actions/card-attachment/get-card-attachment';
import { deleteCardAttachment } from './lib/actions/card-attachment/delete-card-attachment';
import { cardMovedTrigger } from './lib/triggers/cardMoved';
import { newCardTrigger } from './lib/triggers/newCard';
import { deadlineTrigger } from './lib/triggers/deadline';
// TYRBO-PATCH: shared bridge that turns the injected/legacy connection value into { key, token }.
import { toTrelloCreds } from './lib/common/auth';

// TYRBO-PATCH: Tyrbo-managed Trello connect. Users no longer paste an API key —
// the platform holds a single Trello Power-Up API key server-side and each user
// approves via Trello's authorize flow to mint a per-user token, which is all
// that is stored here. The key is injected at run time (engine connection
// resolver) and for validation (server), so the piece only ever handles the
// token. See .agents/features/trello-shared-connect.md.
const markdownProperty = `
Connect your Trello account by authorizing access — no API key needed. You will be redirected to Trello to grant access, and a personal token is minted and stored for you.

If you already have a token from the workspace Power-Up, you can paste it below instead.
`;
export const trelloAuth = PieceAuth.CustomAuth({
  description: markdownProperty,
  required: true,
  props: {
    token: PieceAuth.SecretText({
      displayName: 'Token',
      description: 'Trello token minted for your account',
      required: true,
    }),
  },
  // The stored value is only { token }; the platform API key is injected as the
  // BASIC_AUTH username before this runs (server-side, since validation bypasses
  // the connection resolver). Legacy BYO connections arrive as { username,
  // password }. Both resolve through toTrelloCreds. A missing platform key on a
  // Tyrbo instance surfaces here as an invalid connection rather than a silent
  // failure at run time.
  validate: async ({ auth }) => {
    try {
      const { key, token } = toTrelloCreds(auth);
      const request: HttpRequest = {
        method: HttpMethod.GET,
        url:
          `https://api.trello.com/1/members/me/boards` +
          `?key=` +
          key +
          `&token=` +
          token,
      };
      await httpClient.sendRequest(request);
      return {
        valid: true,
      };
    } catch (e) {
      return {
        valid: false,
        error:
          'Invalid Trello token, or Trello is not configured on this instance.',
      };
    }
  },
});

export const trello = createPiece({
  displayName: 'Trello',
  description: 'Project management tool for teams',
  minimumSupportedRelease: '0.85.5',
  logoUrl: 'https://cdn.activepieces.com/pieces/trello.png',
  authors: ["Salem-Alaa", "kishanprmr", "MoShizzle", "khaledmashaly", "abuaboud", "AshotZaqoyan"],
  categories: [PieceCategory.PRODUCTIVITY],
  auth: trelloAuth,
  actions: [createCard, getCard, updateCard, deleteCard, getCardAttachments, addCardAttachment, getCardAttachment, deleteCardAttachment,
    createCustomApiCallAction({
      auth: trelloAuth,
      baseUrl: () => 'https://api.trello.com/1',
      authLocation: 'queryParams',
      // TYRBO-PATCH: source key + token from the injected/legacy value.
      authMapping: async (auth) => {
        const { key, token } = toTrelloCreds(auth);
        return {
          key,
          token,
        };
      }
    })
  ],
  triggers: [cardMovedTrigger, newCardTrigger, deadlineTrigger],
});
