import { ErrorCode, isNil } from '@activepieces/core-utils';
import { t } from 'i18next';
import React, { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { authenticationApi } from '@/api/authentication-api';
import { LoadingScreen } from '@/components/custom/loading-screen';
import { internalErrorToast } from '@/components/ui/sonner';
import { api } from '@/lib/api';
import { authenticationSession } from '@/lib/authentication-session';
import {
  FROM_QUERY_PARAM,
  LOGIN_QUERY_PARAM,
  PROVIDER_NAME_QUERY_PARAM,
  STATE_QUERY_PARAM,
} from '@/lib/navigation-utils';

const RedirectPage: React.FC = React.memo(() => {
  const location = useLocation();
  const navigate = useNavigate();
  const hasCheckedParams = useRef(false);
  useEffect(() => {
    if (hasCheckedParams.current) {
      return;
    }
    console.log('redirection works, redirecting....');
    hasCheckedParams.current = true;
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    // TYRBO-PATCH: Tyrbo-managed Trello connect returns the minted token in the
    // URL fragment (response_type=token), never the query string, so read it
    // from location.hash and post it back to the opener the same way `code` is.
    const hash = location.hash.startsWith('#')
      ? location.hash.slice(1)
      : location.hash;
    const token = new URLSearchParams(hash).get('token');
    const state = tryParseState(params.get(STATE_QUERY_PARAM));
    if (state && state[LOGIN_QUERY_PARAM] && code) {
      const providerName = state[PROVIDER_NAME_QUERY_PARAM];
      const from = state[FROM_QUERY_PARAM];
      const handleThirdPartyLogin = async () => {
        try {
          const data = await authenticationApi.claimThirdPartyRequest({
            providerName,
            code,
          });
          authenticationSession.saveResponse(data, false);
          if (isNil(data.projectId)) {
            navigate('/create-platform');
            return;
          }
          navigate(from);
        } catch (e) {
          if (
            api.isError(e) &&
            (e.response?.data as { code: ErrorCode })?.code ===
              ErrorCode.INVITATION_ONLY_SIGN_UP
          ) {
            toast(t('Invitation only sign up'), {
              description: t(
                'Please ask your administrator to add you to the organization.',
              ),
            });
          } else {
            internalErrorToast();
          }
          console.error(e);

          navigate('/sign-in');
        }
      };
      handleThirdPartyLogin();
    }

    if (window.opener && code) {
      window.opener.postMessage(
        {
          code: code,
        },
        '*',
      );
    }
    // TYRBO-PATCH: deliver the Trello token to the opener.
    if (window.opener && token) {
      window.opener.postMessage(
        {
          token: token,
        },
        '*',
      );
    }
    if (!window.opener && !code && !token) {
      navigate('/');
    }
  }, [location.search, location.hash]);

  return <LoadingScreen />;
});

RedirectPage.displayName = 'RedirectPage';
const tryParseState = (state: string | null) => {
  if (!state) {
    return null;
  }
  try {
    return JSON.parse(state);
  } catch (e) {
    return null;
  }
};
export { RedirectPage };
