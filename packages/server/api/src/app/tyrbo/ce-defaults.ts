// TYRBO-PATCH: community-edition defaults replacing the deleted proprietary
// packages/server/api/src/app/ee tree. Every export keeps the name and call
// signature of the EE service it replaces, so consuming CE files only swap
// the import path. Semantics are the community-edition behavior: enterprise
// features are disabled, project access is platform-admin-or-project-owner,
// and everything billing/SSO/RBAC/chat related is inert.
import { ActivepiecesError, ErrorCode, isNil, Permission, ProjectId, ProjectRole } from '@activepieces/core-utils'
import { DefaultProjectRole, OPEN_SOURCE_PLAN, PlatformPlanLimits, PlatformRole, Principal, PrincipalType, ProjectType, rolePermissions, SeekPage, TableState } from '@activepieces/shared'
import { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { repoFactory } from '../core/db/repo-factory'
import { ProjectEntity } from '../project/project-entity'
import { UserEntity } from '../user/user-entity'

const projectRepo = repoFactory(ProjectEntity)
const userRepo = repoFactory(UserEntity)

// ---------------------------------------------------------------------------
// Roles & project membership (EE: project-role / project-members / rbac)
// ---------------------------------------------------------------------------

const EPOCH = new Date(0).toISOString()

const syntheticRole = (name: DefaultProjectRole): ProjectRole => ({
    id: `tyrbo-role-${name.toLowerCase()}`,
    created: EPOCH,
    updated: EPOCH,
    name,
    permissions: rolePermissions[name],
    platformId: null,
    type: 'DEFAULT',
})

const ADMIN_ROLE = syntheticRole(DefaultProjectRole.ADMIN)

const projectRoles: Record<string, ProjectRole> = {
    [DefaultProjectRole.ADMIN]: ADMIN_ROLE,
    [DefaultProjectRole.EDITOR]: syntheticRole(DefaultProjectRole.EDITOR),
    [DefaultProjectRole.VIEWER]: syntheticRole(DefaultProjectRole.VIEWER),
}

function findRole({ id, name }: { id?: string, name?: string }): ProjectRole | null {
    const match = Object.values(projectRoles).find((role) => role.id === id || role.name === name)
    return match ?? null
}

function roleNotFound(params: Record<string, unknown>): never {
    throw new ActivepiecesError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        params: {
            message: 'Project role not found',
            ...params,
        },
    })
}

export const projectRoleService = {
    async getOneOrThrowById({ id }: { id: string }): Promise<ProjectRole> {
        return findRole({ id }) ?? roleNotFound({ id })
    },
    async getOneOrThrow({ name }: { name: string, platformId?: string }): Promise<ProjectRole> {
        return findRole({ name }) ?? roleNotFound({ name })
    },
}

async function hasAccessToProject({ userId, projectId }: { userId: string, projectId: ProjectId }): Promise<boolean> {
    const project = await projectRepo().findOneBy({ id: projectId })
    if (isNil(project)) {
        return false
    }
    const user = await userRepo().findOneBy({ id: userId })
    if (isNil(user) || user.platformId !== project.platformId) {
        return false
    }
    return user.platformRole === PlatformRole.ADMIN || project.ownerId === user.id
}

export const getPrincipalRoleOrThrow = async (userId: string, projectId: ProjectId, _log: FastifyBaseLogger): Promise<ProjectRole> => {
    const allowed = await hasAccessToProject({ userId, projectId })
    if (!allowed) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'No role found for the user',
                userId,
                projectId,
            },
        })
    }
    return ADMIN_ROLE
}

export const assertRoleHasPermission = async (principal: Principal, projectId: ProjectId, _permission: Permission, log: FastifyBaseLogger): Promise<void> => {
    if (principal.type !== PrincipalType.USER) {
        return
    }
    await getPrincipalRoleOrThrow(principal.id, projectId, log)
}

export const assertUserHasPermissionToFlow = async (_principal: Principal, _projectId: ProjectId, _operationType: unknown, _log: FastifyBaseLogger): Promise<void> => {
    // Community edition has no per-operation flow permissions.
}

export const rbacService = (_log: FastifyBaseLogger) => ({
    async assertPrinicpalAccessToProject({ principal, projectId }: { principal: Principal, permission?: Permission, projectId: ProjectId }): Promise<void> {
        switch (principal.type) {
            case PrincipalType.ENGINE: {
                if (principal.projectId !== projectId) {
                    throw accessDenied(projectId)
                }
                return
            }
            case PrincipalType.SERVICE: {
                const project = await projectRepo().findOneBy({ id: projectId })
                if (isNil(project) || project.platformId !== principal.platform.id) {
                    throw accessDenied(projectId)
                }
                return
            }
            case PrincipalType.USER: {
                const allowed = await hasAccessToProject({ userId: principal.id, projectId })
                if (!allowed) {
                    throw accessDenied(projectId)
                }
                return
            }
            case PrincipalType.WORKER:
                return
            default:
                throw accessDenied(projectId)
        }
    },
})

function accessDenied(projectId: ProjectId): ActivepiecesError {
    return new ActivepiecesError({
        code: ErrorCode.AUTHORIZATION,
        params: {
            message: 'User not allowed to access this project',
            projectId,
        },
    })
}

export const projectMemberService = (_log: FastifyBaseLogger) => ({
    async getRole({ projectId, userId }: { projectId: ProjectId, userId: string }): Promise<ProjectRole | null> {
        const allowed = await hasAccessToProject({ userId, projectId })
        return allowed ? ADMIN_ROLE : null
    },
    async hasPermissionOnAnyProject(_params: { userId: string, platformId: string, permission: Permission }): Promise<boolean> {
        return false
    },
    async list(_params: { platformId: string, projectId: ProjectId, cursorRequest: string | null, limit: number, projectRoleId: string | undefined }): Promise<SeekPage<ProjectMemberWithUser>> {
        return { data: [], next: null, previous: null }
    },
    async upsert(_params: { projectId: ProjectId, userId: string, projectRoleName: string }): Promise<void> {
        // Community edition has no project membership table.
    },
})

export const projectMemberRepo = () => ({
    async find(_options: unknown): Promise<{ userId: string }[]> {
        return []
    },
})

// ---------------------------------------------------------------------------
// Platform plan / worker groups / concurrency pools (EE: platform-plan)
// ---------------------------------------------------------------------------

const communityPlan = (): PlatformPlanLimits => ({
    ...OPEN_SOURCE_PLAN,
    stripeSubscriptionStartDate: 0,
    stripeSubscriptionEndDate: 0,
})

export const platformPlanService = (log: FastifyBaseLogger) => ({
    async getOrCreateForPlatform(_platformId: string): Promise<PlatformPlanLimits> {
        return communityPlan()
    },
    async update(params: { platformId: string } & Record<string, unknown>): Promise<PlatformPlanLimits> {
        log.warn({ platformId: params.platformId }, '[ce-defaults] ignoring platform plan update; plans are static in the community edition')
        return communityPlan()
    },
    async getUsage(_platformId: string): Promise<never> {
        throw featureDisabled('platform usage tracking')
    },
    async checkActiveFlowsExceededLimit(_platformId: string, _metric: unknown): Promise<void> {
        // No flow limits in the community edition.
    },
})

export const workerGroupService = (_log: FastifyBaseLogger) => ({
    async isCanaryPlatform(_params: { platformId: string }): Promise<boolean> {
        return false
    },
    async isWorkerGroupsEnabled(_params: { platformId: string }): Promise<boolean> {
        return false
    },
    async getWorkerGroupId(_params: { platformId: string }): Promise<string | null> {
        return null
    },
    async getWorkerGroupPlatformId(_params: { workerGroupId: string }): Promise<string | null> {
        return null
    },
})

export const concurrencyPoolService = (_log: FastifyBaseLogger) => ({
    async getPoolLimit(_poolId: string): Promise<number | null> {
        return null
    },
    async getProjectPoolId(_projectId: string): Promise<string | null> {
        return null
    },
})

export const openRouterApi = {
    async createKey(_params: { name: string, limit: number }): Promise<{ key: string, data: { hash: string } }> {
        throw featureDisabled('managed AI credits')
    },
}

function featureDisabled(feature: string): ActivepiecesError {
    return new ActivepiecesError({
        code: ErrorCode.FEATURE_DISABLED,
        params: {
            message: `${feature} is not available in this edition`,
        },
    })
}

// ---------------------------------------------------------------------------
// Authorization route helpers (EE: ee-authorization)
// ---------------------------------------------------------------------------

async function assertPlatformAdmin(request: FastifyRequest): Promise<void> {
    const principal = request.principal
    if (principal.type === PrincipalType.SERVICE) {
        return
    }
    const user = await userRepo().findOneBy({ id: principal.id })
    if (isNil(user) || user.platformRole !== PlatformRole.ADMIN) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not an admin/owner of the platform.',
            },
        })
    }
}

export async function platformMustBeOwnedByCurrentUser(this: unknown, request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    await assertPlatformAdmin(request)
}

export async function platformToEditMustBeOwnedByCurrentUser(this: unknown, request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    await assertPlatformAdmin(request)
}

export const platformMustHaveFeatureEnabled = (selector: (platform: { plan: PlatformPlanLimits }) => boolean | undefined) => {
    return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const enabled = selector({ plan: communityPlan() })
        if (enabled !== true) {
            return reply.code(402).send({
                code: ErrorCode.FEATURE_DISABLED,
                params: {
                    message: 'This feature is not available in this edition',
                },
            })
        }
    }
}

export async function projectMustBeTeamType(this: unknown, request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const body = request.body as { projectId?: string } | undefined
    const query = request.query as { projectId?: string } | undefined
    const projectId = body?.projectId ?? query?.projectId
    if (isNil(projectId)) {
        return
    }
    const project = await projectRepo().findOneBy({ id: projectId })
    if (isNil(project) || project.type !== ProjectType.TEAM) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'Only team projects support this operation',
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Platform projects (EE: platform-project-service)
// ---------------------------------------------------------------------------

export const platformProjectService = (_log: FastifyBaseLogger) => ({
    async deletePersonalProjectForUser({ userId, platformId }: { userId: string, platformId: string }): Promise<void> {
        await projectRepo().softDelete({
            ownerId: userId,
            platformId,
            type: ProjectType.PERSONAL,
        })
    },
})

// ---------------------------------------------------------------------------
// Email (EE: smtp email sender / email service)
// ---------------------------------------------------------------------------

export const smtpEmailSender = (_log: FastifyBaseLogger) => ({
    isSmtpConfigured(): boolean {
        return false
    },
})

export const emailService = (log: FastifyBaseLogger) => ({
    async sendInvitation(_params: unknown): Promise<void> {
        log.info('[ce-defaults] SMTP is not configured; invitation email skipped')
    },
    async sendProjectMemberAdded(_params: unknown): Promise<void> {
        log.info('[ce-defaults] SMTP is not configured; member-added email skipped')
    },
})

// ---------------------------------------------------------------------------
// Secret managers (EE: secret-managers)
// ---------------------------------------------------------------------------

export function containsSecretManagerReference(_value: unknown): boolean {
    return false
}

export const secretManagersService = (_log: FastifyBaseLogger) => ({
    async resolveObject<T>({ value }: { value: T, platformId: string, projectIds?: string[], throwOnFailure?: boolean }): Promise<T> {
        return value
    },
    async resolveString({ key }: { key: string, platformId: string, projectIds?: string[], throwOnFailure?: boolean }): Promise<string> {
        return key
    },
})

// ---------------------------------------------------------------------------
// Federated auth / SAML / OTP (EE: authentication)
// ---------------------------------------------------------------------------

export const federatedAuthnService = (_log: FastifyBaseLogger) => ({
    async getThirdPartyRedirectUrl(): Promise<string | undefined> {
        return undefined
    },
})

export function invalidateSamlClientCache(_platformId: string): void {
    // SAML is not available in the community edition.
}

export const otpService = (_log: FastifyBaseLogger) => ({
    async createAndSend(_params: { platformId: string | null, email: string, type: unknown }): Promise<void> {
        // OTP email verification is not available in the community edition.
    },
})

// ---------------------------------------------------------------------------
// Chat (EE: chat)
// ---------------------------------------------------------------------------

export const chatVisibilityHelper = {
    async resolveChatEnabledForUser(_params: { userId: string, platform: unknown, isEmbedded: boolean }): Promise<boolean> {
        return false
    },
}

export const chatRpcHandlers = (_log: FastifyBaseLogger) => ({
    async getChatConfig(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async saveChatMessages(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async saveChatFile(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async updateChatProgress(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async heartbeatChatConversation(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async updateProjectContext(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async executeChatTool(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
    async sendChatEmail(_input: unknown): Promise<never> {
        throw featureDisabled('chat')
    },
})

// ---------------------------------------------------------------------------
// Alerts (EE: alerts)
// ---------------------------------------------------------------------------

export const alertsService = (_log: FastifyBaseLogger) => ({
    async sendAlertOnRunFinish(_params: { issueToAlert: unknown, flowRunId: string, failedStep: unknown }): Promise<void> {
        // Alerts are not available in the community edition.
    },
})

// ---------------------------------------------------------------------------
// Git sync & project releases (EE: project-release)
// ---------------------------------------------------------------------------

export const gitRepoService = (_log: FastifyBaseLogger) => ({
    async onDeleted(_params: { type: unknown, externalId: string | undefined, userId: string, projectId: string, platformId: string, log: FastifyBaseLogger }): Promise<void> {
        // Git sync is not available in the community edition.
    },
})

export const projectStateService = (_log: FastifyBaseLogger) => ({
    getTableState(table: PopulatedTableLike): TableState {
        return {
            id: table.id,
            name: table.name,
            externalId: table.externalId,
            status: table.status ?? null,
            trigger: table.trigger ?? null,
            fields: table.fields.map((field) => ({
                name: field.name,
                type: field.type,
                data: field.data ?? undefined,
                externalId: field.externalId,
            })) as TableState['fields'],
        }
    },
})

// ---------------------------------------------------------------------------
// Platform templates (EE: template)
// ---------------------------------------------------------------------------

export const platformTemplateService = () => ({
    async create(_params: unknown): Promise<never> {
        throw featureDisabled('custom platform templates')
    },
    async update(_params: unknown): Promise<never> {
        throw featureDisabled('custom platform templates')
    },
})

// ---------------------------------------------------------------------------
// Embedding (EE: embed-subdomain)
// ---------------------------------------------------------------------------

export const embedSubdomainService = (_log: FastifyBaseLogger) => ({
    async getByHostname(_params: { hostname: string }): Promise<{ platformId: string } | null> {
        return null
    },
})

// ---------------------------------------------------------------------------
// Piece filtering (EE: piece-filtering-utils)
// ---------------------------------------------------------------------------

export const enterpriseFilteringUtils = (_log: FastifyBaseLogger) => ({
    async isFiltered(_params: { piece: unknown, projectId: string | undefined, platformId: string | undefined }): Promise<boolean> {
        return false
    },
    async filter<T>(params: { pieces: T[] } & Record<string, unknown>): Promise<T[]> {
        return params.pieces
    },
})

type ProjectMemberWithUser = {
    user: {
        firstName: string
        lastName: string
        email: string
    }
}

type PopulatedTableLike = {
    id: string
    name: string
    externalId: string
    status?: TableState['status']
    trigger?: TableState['trigger']
    fields: {
        name: string
        type: string
        externalId: string
        data?: unknown
    }[]
}
