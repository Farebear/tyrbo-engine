import { createAction, Property } from '@activepieces/pieces-framework';
import {
  httpClient,
  HttpRequest,
  HttpMethod,
} from '@activepieces/pieces-common';
import { trelloCommon } from '../../common';
// TYRBO-PATCH: source key + token from the resolved connection value.
import { toTrelloCreds } from '../../common/auth';
import { trelloAuth } from '../../..';

export const deleteCard = createAction({
  auth: trelloAuth,
  name: 'delete_card',
  displayName: 'Delete Card',
  description: 'Deletes an existing card.',
  audience: 'both',
  aiMetadata: { description: 'Permanently deletes a Trello card by its card_id. Use to remove a card entirely (this is irreversible, unlike archiving via Update Card with closed=true). Requires card_id; deleting the same id again returns an error once it no longer exists.', idempotent: false },
  props: {
    card_id: Property.ShortText({
      description: 'The ID of the card to delete.',
      displayName: 'Card ID',
      required: true,
    }),
  },

  async run(context) {
    const { key, token } = toTrelloCreds(context.auth);
    const request: HttpRequest = {
      method: HttpMethod.DELETE,
      url:
        `${trelloCommon.baseUrl}cards/${context.propsValue['card_id']}` +
        `?key=` +
        key +
        `&token=` +
        token,
      headers: {
        Accept: 'application/json',
      },
      queryParams: {},
    };
    
    const response = await httpClient.sendRequest(request);

    return response.body;
  },
});