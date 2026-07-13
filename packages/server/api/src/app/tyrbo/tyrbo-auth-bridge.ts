// TYRBO-PATCH: auth bridge between the tyrbo product API and this engine.
//
// The product API (app.tyrbo.ai) mints short-lived RS256 JWTs for its users;
// this module verifies them against a shared public key and maps the token's
// org onto an engine project:
//
//   POST /v1/tyrbo/auth/exchange   body: { token }
//
//   token claims: iss  AP_TYRBO_JWT_ISSUER (default 'tyrbo')
//                 aud  'tyrbo-engine'
//                 sub  product-side user id (informational)
//                 email, first_name?, last_name?
//                 org_id   → engine project (created on first sight,
//                            project.externalId = org_id)
//                 org_name? → display name for a newly created project
//
// Provisioning is idempotent: user identity by email, user on the single
// platform (bootstrapped on the very first exchange), TEAM project per org,
// and org membership recorded in project.metadata.tyrboMembers so the
// community access rule (see ce-defaults.ts) admits every org member, not
// just the project owner. The response is the standard AuthenticationResponse
// (engine session token + projectId) the builder SPA already understands.
import { ActivepiecesError, ErrorCode, isNil } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { AuthenticationResponse, Project, ProjectType, UserIdentity, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { authenticationUtils } from '../authentication/authentication-utils'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { JwtSignAlgorithm, jwtUtils } from '../helper/jwt-utils'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { platformService } from '../platform/platform.service'
import { ProjectEntity } from '../project/project-entity'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'

const TYRBO_TOKEN_AUDIENCE = 'tyrbo-engine'

const projectRepo = repoFactory(ProjectEntity)

export const tyrboAuthBridgeModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(tyrboAuthBridgeController, { prefix: '/v1/tyrbo/auth' })
}

const tyrboAuthBridgeController: FastifyPluginAsyncZod = async (app) => {
    app.post('/exchange', ExchangeRequest, async (request): Promise<AuthenticationResponse> => {
        const claims = await verifyTyrboToken(request.body.token)
        return provision(claims, request.log)
    })
}

async function verifyTyrboToken(token: string): Promise<TyrboTokenClaims> {
    const publicKey = system.get(AppSystemProp.TYRBO_JWT_PUBLIC_KEY)?.replace(/\\n/g, '\n')
    if (isNil(publicKey) || publicKey.length === 0) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHENTICATION,
            params: {
                message: 'AP_TYRBO_JWT_PUBLIC_KEY is not configured on this engine',
            },
        })
    }
    const issuer = system.get(AppSystemProp.TYRBO_JWT_ISSUER) ?? 'tyrbo'
    const decoded = await jwtUtils.decodeAndVerify<Record<string, unknown>>({
        jwt: token,
        key: publicKey,
        algorithm: JwtSignAlgorithm.RS256,
        issuer,
        audience: TYRBO_TOKEN_AUDIENCE,
    })
    const parsed = TyrboTokenClaims.safeParse(decoded)
    if (!parsed.success) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHENTICATION,
            params: {
                message: `tyrbo token is missing required claims: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
            },
        })
    }
    return parsed.data
}

async function provision(claims: TyrboTokenClaims, log: FastifyBaseLogger): Promise<AuthenticationResponse> {
    const identity = await getOrCreateIdentity(claims, log)
    const platformId = await getOrBootstrapPlatformId(identity, log)
    const user = await userService(log).getOrCreateWithProject({
        identity,
        platformId,
    })
    const orgProject = await getOrCreateOrgProject({ claims, platformId, ownerId: user.id, log })
    await ensureOrgMembership(orgProject, user.id)
    return authenticationUtils(log).getProjectAndToken({
        userId: user.id,
        platformId,
        projectId: orgProject.id,
    })
}

async function getOrCreateIdentity(claims: TyrboTokenClaims, log: FastifyBaseLogger): Promise<UserIdentity> {
    const existing = await userIdentityService(log).getIdentityByEmail(claims.email)
    if (!isNil(existing)) {
        return existing
    }
    return userIdentityService(log).create({
        email: claims.email,
        firstName: claims.first_name ?? 'Tyrbo',
        lastName: claims.last_name ?? 'User',
        password: await cryptoUtils.generateRandomPassword(),
        provider: UserIdentityProvider.JWT,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
}

async function getOrBootstrapPlatformId(identity: UserIdentity, log: FastifyBaseLogger): Promise<string> {
    const platform = await platformService(log).getOldestPlatform()
    if (!isNil(platform)) {
        return platform.id
    }
    log.info({ identity: { id: identity.id } }, '[tyrboAuthBridge] no platform yet — bootstrapping from first exchange')
    await platformService(log).createPlatformWithProject({
        identityId: identity.id,
        name: 'Tyrbo',
        invalidatePreviousTokens: false,
    })
    const created = await platformService(log).getOldestPlatform()
    if (isNil(created)) {
        throw new Error('platform bootstrap failed')
    }
    return created.id
}

async function getOrCreateOrgProject({ claims, platformId, ownerId, log }: { claims: TyrboTokenClaims, platformId: string, ownerId: string, log: FastifyBaseLogger }): Promise<Project> {
    const existing = await projectService(log).getByPlatformIdAndExternalId({
        platformId,
        externalId: claims.org_id,
    })
    if (!isNil(existing)) {
        return existing
    }
    log.info({ org: { id: claims.org_id } }, '[tyrboAuthBridge] creating engine project for org')
    return projectService(log).create({
        ownerId,
        displayName: claims.org_name ?? `Org ${claims.org_id}`,
        platformId,
        type: ProjectType.TEAM,
        externalId: claims.org_id,
    })
}

// Org membership lives in project.metadata.tyrboMembers (a plain jsonb
// column upstream never interprets); ce-defaults and the project access
// filter read it so non-owner org members can use the project.
async function ensureOrgMembership(project: Project, userId: string): Promise<void> {
    const metadata = (project.metadata ?? {}) as Record<string, unknown>
    const members = Array.isArray(metadata.tyrboMembers) ? metadata.tyrboMembers as string[] : []
    if (project.ownerId === userId || members.includes(userId)) {
        return
    }
    await projectRepo().update(project.id, {
        metadata: {
            ...metadata,
            tyrboMembers: [...members, userId],
        },
    })
}

const ExchangeRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        body: z.object({
            token: z.string().min(1),
        }),
    },
}

const TyrboTokenClaims = z.object({
    sub: z.string().min(1),
    email: z.string().email(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    org_id: z.string().min(1),
    org_name: z.string().optional(),
})

type TyrboTokenClaims = z.infer<typeof TyrboTokenClaims>
