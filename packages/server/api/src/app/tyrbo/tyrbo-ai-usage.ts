// TYRBO-PATCH: per-run AI usage aggregation for the run-completion webhook
// (fork patch #7, M8.5).
//
// @tyrbo/piece-ai actions write a `$ai` marker into their step output:
//   { provider: 'anthropic'|'openai', model, tokensIn, tokensOut }
// This module walks a finished run's step outputs (the same walk as the
// upstream ai-usage-extractor: recurse loop iterations, resolve SLICE
// outputs through the log-slice fetcher) and folds the markers into one
// entry per step name — tokens summed across loop iterations, `calls`
// counting invocations — matching the product-side `runAiUsageSchema`
// contract in Farebear/tyrbo `packages/credits/src/ai-rates.ts`.
//
// Billing safety: this is best-effort input to billing, never a gate — the
// caller drops `aiUsage` (and the product charges 0 AI credits, loudly) on
// any failure rather than blocking the run summary.

import { isNil } from '@activepieces/core-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    LogSliceRef,
    LoopStepResult,
    Step,
    StepOutput,
    StepOutputStatus,
    StepOutputType,
} from '@activepieces/shared'

export const TYRBO_AI_PIECE_NAME = '@tyrbo/piece-ai'

/** Marker key @tyrbo/piece-ai writes into step outputs. */
export const TYRBO_AI_MARKER_KEY = '$ai'

const AI_PROVIDERS = ['anthropic', 'openai'] as const

export type TyrboAiUsageEntry = {
    stepName: string
    provider: (typeof AI_PROVIDERS)[number]
    model: string
    tokensIn: number
    tokensOut: number
    calls: number
}

export type SliceFetcher = (ref: LogSliceRef) => Promise<unknown>

/** Step names of @tyrbo/piece-ai steps in the flow version (loops included). */
export function tyrboAiStepNames(flowVersion: FlowVersion): Set<string> {
    return flowStructureUtil
        .getAllSteps(flowVersion.trigger)
        .filter(isTyrboAiStep)
        .reduce((names, step) => names.add(step.name), new Set<string>())
}

function isTyrboAiStep(step: Step): boolean {
    return step.type === FlowActionType.PIECE && step.settings.pieceName === TYRBO_AI_PIECE_NAME
}

type AggregateParams = {
    steps: Record<string, StepOutput>
    aiStepNames: Set<string>
    fetchSlice: SliceFetcher
}

export async function aggregateTyrboAiUsage({ steps, aiStepNames, fetchSlice }: AggregateParams): Promise<TyrboAiUsageEntry[]> {
    const byStep = new Map<string, TyrboAiUsageEntry>()
    await collect({ steps, aiStepNames, fetchSlice, byStep })
    return [...byStep.values()]
}

type CollectParams = AggregateParams & {
    byStep: Map<string, TyrboAiUsageEntry>
}

async function collect({ steps, aiStepNames, fetchSlice, byStep }: CollectParams): Promise<void> {
    for (const [stepName, output] of Object.entries(steps)) {
        if (aiStepNames.has(stepName) && output.status === StepOutputStatus.SUCCEEDED) {
            const marker = await resolveMarker(output, fetchSlice)
            if (!isNil(marker)) {
                accumulate(byStep, stepName, marker)
            }
        }
        if (output.type === FlowActionType.LOOP_ON_ITEMS) {
            const iterations = (output.output as LoopStepResult | undefined)?.iterations ?? []
            for (const iteration of iterations) {
                await collect({ steps: iteration, aiStepNames, fetchSlice, byStep })
            }
        }
    }
}

async function resolveMarker(output: StepOutput, fetchSlice: SliceFetcher): Promise<AiMarker | null> {
    const raw = output.outputType === StepOutputType.SLICE
        ? await fetchSlice(output.output as LogSliceRef)
        : output.output
    if (typeof raw !== 'object' || isNil(raw) || Array.isArray(raw)) {
        return null
    }
    return parseMarker((raw as Record<string, unknown>)[TYRBO_AI_MARKER_KEY])
}

function accumulate(byStep: Map<string, TyrboAiUsageEntry>, stepName: string, marker: AiMarker): void {
    const entry = byStep.get(stepName)
    if (isNil(entry)) {
        byStep.set(stepName, { stepName, ...marker, calls: 1 })
        return
    }
    entry.tokensIn += marker.tokensIn
    entry.tokensOut += marker.tokensOut
    entry.calls += 1
    // Model is a static per-step prop, so iterations agree; keep the latest
    // marker's provider/model in the (unreachable in practice) mixed case.
    entry.provider = marker.provider
    entry.model = marker.model
}

type AiMarker = Omit<TyrboAiUsageEntry, 'stepName' | 'calls'>

function parseMarker(value: unknown): AiMarker | null {
    if (typeof value !== 'object' || isNil(value) || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    const provider = record['provider']
    const model = record['model']
    const tokensIn = asTokenCount(record['tokensIn'])
    const tokensOut = asTokenCount(record['tokensOut'])
    const validProvider = AI_PROVIDERS.find((candidate) => candidate === provider)
    if (isNil(validProvider) || typeof model !== 'string' || model.length === 0 || isNil(tokensIn) || isNil(tokensOut)) {
        return null
    }
    return { provider: validProvider, model, tokensIn, tokensOut }
}

function asTokenCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null
    }
    return Math.floor(value)
}
