// TYRBO-PATCH: community replacement for the deleted EE platform-project
// module. Serves the minimal /v1/projects surface the builder UI needs
// (list, get, create) and re-registers the CE worker project controller
// that upstream only wired through the EE module.
import { ActivepiecesError, ApId, ErrorCode, isNil } from '@activepieces/core-utils'
import { PiecesFilterType, PrincipalType, Project, ProjectType, ProjectWithLimits, SeekPage } from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { projectService } from '../project/project-service'
import { projectWorkerController } from '../project/project-worker-controller'
import { userService } from '../user/user-service'
import { rbacService } from './ce-defaults'

export const tyrboProjectModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(tyrboProjectController, { prefix: '/v1/projects' })
    await app.register(projectWorkerController, { prefix: '/v1/worker/project' })
}

const tyrboProjectController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListProjectsRequest, async (request): Promise<SeekPage<ProjectWithLimits>> => {
        const principal = request.principal
        const projects = await listProjectsForPrincipal(request.log, principal)
        return {
            data: projects.map(toProjectWithLimits),
            next: null,
            previous: null,
        }
    })

    app.get('/:id', GetProjectRequest, async (request): Promise<ProjectWithLimits> => {
        await rbacService(request.log).assertPrinicpalAccessToProject({
            principal: request.principal,
            projectId: request.params.id,
        })
        const project = await projectService(request.log).getOneOrThrow(request.params.id)
        return toProjectWithLimits(project)
    })

    app.post('/', CreateProjectRequest, async (request, reply): Promise<ProjectWithLimits> => {
        const project = await projectService(request.log).create({
            ownerId: request.principal.id,
            displayName: request.body.displayName,
            platformId: request.principal.platform.id,
            type: ProjectType.TEAM,
            externalId: request.body.externalId,
        })
        await reply.status(StatusCodes.CREATED)
        return toProjectWithLimits(project)
    })
}

async function listProjectsForPrincipal(log: Parameters<typeof projectService>[0], principal: { id: string, type: PrincipalType, platform: { id: string } }): Promise<Project[]> {
    if (principal.type === PrincipalType.SERVICE) {
        const projectIds = await projectService(log).getProjectIdsByPlatform(principal.platform.id)
        const projects = await Promise.all(projectIds.map((id) => projectService(log).getOne(id)))
        return projects.filter((project): project is Project => !isNil(project))
    }
    const user = await userService(log).getOneOrFail({ id: principal.id })
    if (isNil(user.platformId)) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not associated with a platform.',
            },
        })
    }
    return projectService(log).getAllForUser({
        platformId: user.platformId,
        userId: user.id,
        isPrivileged: userService(log).isUserPrivileged(user),
    })
}

function toProjectWithLimits(project: Project): ProjectWithLimits {
    const { deleted: _deleted, ...rest } = project
    return {
        ...rest,
        plan: {
            id: project.id,
            created: project.created,
            updated: project.updated,
            projectId: project.id,
            locked: false,
            name: 'community',
            piecesFilterType: PiecesFilterType.NONE,
            pieces: [],
        },
        analytics: {
            totalUsers: 1,
            activeUsers: 1,
            totalFlows: 0,
            activeFlows: 0,
        },
    }
}

const ListProjectsRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        querystring: z.object({
            cursor: z.string().optional(),
            limit: z.coerce.number().optional(),
            displayName: z.string().optional(),
        }),
    },
}

const GetProjectRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        params: z.object({
            id: ApId,
        }),
    },
}

const CreateProjectRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        body: z.object({
            displayName: z.string(),
            externalId: z.string().optional(),
        }),
    },
}
