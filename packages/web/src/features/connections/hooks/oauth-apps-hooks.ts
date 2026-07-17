import {
  UpsertOAuth2AppRequest,
  AppConnectionType,
} from '@activepieces/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { toast } from 'sonner';

import { PiecesOAuth2AppsMap } from '@/features/connections/utils/oauth2-utils';

import { oauthAppsApi } from '../api/oauth-apps';

export const oauthAppsMutations = {
  useDeleteOAuthApp: (refetch: () => void, setOpen: (open: boolean) => void) =>
    useMutation({
      mutationFn: async (credentialId: string) => {
        await oauthAppsApi.delete(credentialId);
        refetch();
      },
      onSuccess: () => {
        toast.success(t('OAuth2 Credentials Deleted'), {
          duration: 3000,
        });
        setOpen(false);
      },
    }),

  useUpsertOAuthApp: (
    refetch: () => void,
    setOpen: (open: boolean) => void,
    onConfigurationDone: () => void,
  ) =>
    useMutation({
      mutationFn: async (request: UpsertOAuth2AppRequest) => {
        await oauthAppsApi.upsert(request);
        refetch();
      },
      onSuccess: () => {
        toast.success(t('OAuth2 Credentials Updated'), {
          duration: 3000,
        });
        onConfigurationDone();
        setOpen(false);
      },
    }),
};

export const oauthAppsQueries = {
  useOAuthAppConfigured(pieceId: string) {
    const query = useQuery({
      queryKey: ['oauth2-apps-configured'],
      queryFn: async () => {
        const response = await oauthAppsApi.listPlatformOAuth2Apps({
          limit: 1000000,
        });
        return response.data;
      },
      select: (data) => {
        return data.find((app) => app.pieceName === pieceId);
      },
      staleTime: Infinity,
    });
    return {
      refetch: query.refetch,
      oauth2App: query.data,
    };
  },
  usePiecesOAuth2AppsMap() {
    return useQuery<PiecesOAuth2AppsMap, Error>({
      queryKey: ['oauth-apps'],
      queryFn: async () => {
        // TYRBO-PATCH: the community server now serves env-configured
        // Tyrbo-managed clients from /v1/oauth-apps (tyrbo-oauth-apps.ts), so
        // drop upstream's edition short-circuit. Cloud OAuth apps
        // (secrets.activepieces.com) stay off entirely: this fork never
        // proxies authorization codes through Activepieces cloud, and pieces
        // without a Tyrbo-managed client fall back to the BYO client-id form.
        // A failed listing degrades to BYO for everything rather than
        // erroring the dialog (upstream CE never fetched here at all).
        const apps = await oauthAppsApi
          .listPlatformOAuth2Apps({
            limit: 1000000,
            cursor: undefined,
          })
          .catch(() => ({ data: [] }));
        const appsMap: PiecesOAuth2AppsMap = {};
        apps.data.forEach((app) => {
          appsMap[app.pieceName] = {
            platformOAuth2App: {
              oauth2Type: AppConnectionType.PLATFORM_OAUTH2,
              clientId: app.clientId,
            },
            cloudOAuth2App: null,
          };
        });
        return appsMap;
      },
      staleTime: 0,
    });
  },
};

export type PieceToClientIdMap = {
  [
    pieceName: `${string}-${
      | AppConnectionType.CLOUD_OAUTH2
      | AppConnectionType.PLATFORM_OAUTH2}`
  ]: {
    oauth2Type:
      | AppConnectionType.CLOUD_OAUTH2
      | AppConnectionType.PLATFORM_OAUTH2;
    clientId: string;
  };
};
