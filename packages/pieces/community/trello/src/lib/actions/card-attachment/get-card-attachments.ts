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

export const getCardAttachments = createAction({
  auth: trelloAuth,
  name: 'get_card_attachments',
  displayName: 'Get All Card Attachments',
  description: 'Gets all attachments on a card.',
  audience: 'both',
  aiMetadata: { description: 'Lists all attachments on a Trello card identified by card_id. Use to enumerate the files and links attached to a card, e.g. to find an attachment id before fetching or deleting it. Read-only and idempotent.', idempotent: true },
  props: {
    card_id: Property.ShortText({
      description: 'The ID of the card to get attachments from',
      displayName: 'Card ID',
      required: true,
    })
  },

  async run(context) {
    const { key, token } = toTrelloCreds(context.auth);
    const request: HttpRequest = {
      method: HttpMethod.GET,
      url:
        `${trelloCommon.baseUrl}cards/${context.propsValue['card_id']}/attachments` +
        `?key=` +
        key +
        `&token=` +
        token,
      headers: {
        Accept: 'application/json',
      },
    };
    
    const response = await httpClient.sendRequest(request);

    return response.body;
  },
});
