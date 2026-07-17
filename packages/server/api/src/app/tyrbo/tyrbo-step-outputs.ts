// TYRBO-PATCH: shared step-output walk for run-completion usage aggregation.
//
// Both usage aggregators (tyrbo-ai-usage.ts, tyrbo-browser-usage.ts) need the
// same traversal of a finished run's step outputs: visit every SUCCEEDED
// occurrence of a named step — recursing into loop iterations — and resolve
// SLICE outputs through the log-slice fetcher so the piece-written marker
// object is readable. This module owns that walk; the aggregators only parse
// their marker out of the resolved outputs.

import { isNil } from '@activepieces/core-utils'
import {
    FlowActionType,
    LogSliceRef,
    LoopStepResult,
    StepOutput,
    StepOutputStatus,
    StepOutputType,
} from '@activepieces/shared'

/**
 * Resolved outputs of every SUCCEEDED occurrence of the named steps, loop
 * iterations included — one entry per occurrence, in execution order.
 */
export async function resolveTyrboStepOutputs({ steps, stepNames, fetchSlice }: ResolveParams): Promise<ResolvedStepOutput[]> {
    const resolved: ResolvedStepOutput[] = []
    for (const [stepName, output] of Object.entries(steps)) {
        if (stepNames.has(stepName) && output.status === StepOutputStatus.SUCCEEDED) {
            const raw = output.outputType === StepOutputType.SLICE
                ? await fetchSlice(output.output as LogSliceRef)
                : output.output
            if (typeof raw === 'object' && !isNil(raw) && !Array.isArray(raw)) {
                resolved.push({ stepName, output: raw as Record<string, unknown> })
            }
        }
        if (output.type === FlowActionType.LOOP_ON_ITEMS) {
            const iterations = (output.output as LoopStepResult | undefined)?.iterations ?? []
            for (const iteration of iterations) {
                resolved.push(...await resolveTyrboStepOutputs({ steps: iteration, stepNames, fetchSlice }))
            }
        }
    }
    return resolved
}

export type SliceFetcher = (ref: LogSliceRef) => Promise<unknown>

export type ResolvedStepOutput = {
    stepName: string
    output: Record<string, unknown>
}

type ResolveParams = {
    steps: Record<string, StepOutput>
    stepNames: Set<string>
    fetchSlice: SliceFetcher
}
