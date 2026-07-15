// TYRBO-PATCH: run-completion webhook to the tyrbo product API.
//
// When a flow run reaches a terminal state, POST a run summary to
// AP_TYRBO_API_URL (the full endpoint URL; unset = disabled). The product
// side uses it to mirror runs into Supabase and debit credits, so delivery
// is retried with exponential backoff; a run that still cannot be delivered
// is logged and left to the product-side reconciliation sweep.
//
//   POST $AP_TYRBO_API_URL
//   Authorization: Bearer $AP_TYRBO_WEBHOOK_SECRET   (when configured)
//   { runId, orgId, engineProjectId, flowId, flowVersionId, status,
//     environment, startTime, finishTime, durationMs, stepsCount,
//     failedStepName, tags, aiUsage? }
//
// orgId is the engine project's externalId, written by the auth bridge
// (tyrbo-auth-bridge.ts) — the product joins on it without cross-DB queries.
// The engine's SSRF filter applies: point AP_SSRF_ALLOW_LIST at the product
// host when it resolves to a private address (e.g. in docker compose).
//
// aiUsage (M8.5): when the flow contains @tyrbo/piece-ai steps, the payload
// additionally carries one aggregated entry per AI step (tokens summed
// across loop iterations) for `ai_step_debit` billing — see
// tyrbo-ai-usage.ts. Aggregation is best-effort: on any failure the summary
// posts without the field and the product charges 0 AI credits.
import { isNil, spreadIfDefined } from '@activepieces/core-utils'
import { safeHttp } from '@activepieces/server-utils'
import { FileType, FlowRun, LogSliceRef } from '@activepieces/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { fileService } from '../file/file.service'
import { flowRunService } from '../flows/flow-run/flow-run-service'
import { flowVersionService } from '../flows/flow-version/flow-version.service'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { projectService } from '../project/project-service'
import { aggregateTyrboAiUsage, TyrboAiUsageEntry, tyrboAiStepNames } from './tyrbo-ai-usage'

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 10_000

export const tyrboRunWebhook = (log: FastifyBaseLogger) => ({
    async notifyRunFinished(flowRun: FlowRun): Promise<void> {
        const url = system.get(AppSystemProp.TYRBO_API_URL)
        if (isNil(url) || url.length === 0) {
            return
        }
        const payload = await buildRunSummary(flowRun, log)
        const secret = system.get(AppSystemProp.TYRBO_WEBHOOK_SECRET)

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await safeHttp.axios.post(url, payload, {
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: {
                        'Content-Type': 'application/json',
                        ...spreadIfDefined('Authorization', isNil(secret) ? undefined : `Bearer ${secret}`),
                    },
                })
                log.debug({ flowRun: { id: flowRun.id }, attempt }, '[tyrboRunWebhook] run summary delivered')
                return
            }
            catch (error) {
                const lastAttempt = attempt === MAX_ATTEMPTS
                log[lastAttempt ? 'error' : 'warn'](
                    { flowRun: { id: flowRun.id }, attempt, error: error instanceof Error ? error.message : String(error) },
                    lastAttempt
                        ? '[tyrboRunWebhook] giving up on run summary delivery; product-side reconciliation must pick this run up'
                        : '[tyrboRunWebhook] run summary delivery failed, backing off',
                )
                if (lastAttempt) {
                    return
                }
                await sleep(backoffDelayMs(attempt))
            }
        }
    },
})

async function buildRunSummary(flowRun: FlowRun, log: FastifyBaseLogger): Promise<TyrboRunSummary> {
    const project = await projectService(log).getOne(flowRun.projectId)
    const durationMs = !isNil(flowRun.startTime) && !isNil(flowRun.finishTime)
        ? dayjs(flowRun.finishTime).diff(dayjs(flowRun.startTime), 'millisecond')
        : null
    const aiUsage = await collectAiUsage(flowRun, log)
    return {
        runId: flowRun.id,
        orgId: project?.externalId ?? null,
        engineProjectId: flowRun.projectId,
        flowId: flowRun.flowId,
        flowVersionId: flowRun.flowVersionId,
        status: flowRun.status,
        environment: flowRun.environment,
        startTime: flowRun.startTime ?? null,
        finishTime: flowRun.finishTime ?? null,
        durationMs,
        stepsCount: flowRun.stepsCount ?? null,
        failedStepName: flowRun.failedStep?.name ?? null,
        tags: flowRun.tags ?? [],
        ...spreadIfDefined('aiUsage', aiUsage),
    }
}

async function collectAiUsage(flowRun: FlowRun, log: FastifyBaseLogger): Promise<TyrboAiUsageEntry[] | undefined> {
    try {
        const flowVersion = await flowVersionService(log).getOne(flowRun.flowVersionId)
        if (isNil(flowVersion)) {
            return undefined
        }
        const aiStepNames = tyrboAiStepNames(flowVersion)
        if (aiStepNames.size === 0) {
            return undefined
        }
        const steps = await flowRunService(log).getStepsOrNull({ flowRun })
        if (isNil(steps)) {
            return undefined
        }
        const entries = await aggregateTyrboAiUsage({
            steps,
            aiStepNames,
            fetchSlice: (ref) => fetchSlice(log, flowRun.projectId, ref),
        })
        return entries.length > 0 ? entries : undefined
    }
    catch (error) {
        log.warn(
            { flowRun: { id: flowRun.id }, error: error instanceof Error ? error.message : String(error) },
            '[tyrboRunWebhook] AI usage aggregation failed; posting run summary without aiUsage',
        )
        return undefined
    }
}

async function fetchSlice(log: FastifyBaseLogger, projectId: string, ref: LogSliceRef): Promise<unknown> {
    const file = await fileService(log).getDataOrUndefined({
        projectId,
        fileId: ref.fileId,
        type: FileType.FLOW_RUN_LOG_SLICE,
    })
    if (isNil(file)) {
        return undefined
    }
    return JSON.parse(file.data.toString('utf-8'))
}

function backoffDelayMs(attempt: number): number {
    const exponential = BASE_DELAY_MS * 4 ** (attempt - 1)
    const jitter = Math.floor(Math.random() * BASE_DELAY_MS)
    return exponential + jitter
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

type TyrboRunSummary = {
    runId: string
    orgId: string | null
    engineProjectId: string
    flowId: string
    flowVersionId: string
    status: string
    environment: string
    startTime: string | null
    finishTime: string | null
    durationMs: number | null
    stepsCount: number | null
    failedStepName: string | null
    tags: string[]
    aiUsage?: TyrboAiUsageEntry[]
}
