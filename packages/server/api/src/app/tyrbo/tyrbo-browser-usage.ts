// TYRBO-PATCH: per-run cloud browser time for the run-completion webhook.
//
// @tyrbo/piece-browser's `run` action writes a `$run` diagnostics object into
// its step output, carrying the executor-reported `durationMs` of the
// browser.run job (BrowserRunJobResult — the queue contract in
// packages/pieces/custom/browser/src/lib/contract.ts) and, since piece
// v0.2.0, the group's `execution` mode. This module sums `durationMs` across
// a run's CLOUD-executed browser groups (loop iterations included) into one
// `cloudBrowserMs` number for the run summary. Local/device-queue groups —
// and pre-v0.2.0 outputs, which lack `execution` — never count: undercount
// beats overbilling.
//
// Billing safety mirrors tyrbo-ai-usage.ts: best-effort input to billing,
// never a gate. The consumer (Farebear/tyrbo apps/web /api/engine/runs)
// meters zero when the field is absent or malformed.

import { isNil } from '@activepieces/core-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    Step,
    StepOutput,
} from '@activepieces/shared'
import { resolveTyrboStepOutputs, SliceFetcher } from './tyrbo-step-outputs'

export const TYRBO_BROWSER_PIECE_NAME = '@tyrbo/piece-browser'

/** Diagnostics key @tyrbo/piece-browser writes into step outputs. */
export const TYRBO_BROWSER_MARKER_KEY = '$run'

/** Step names of @tyrbo/piece-browser steps in the flow version (loops included). */
export function tyrboBrowserStepNames(flowVersion: FlowVersion): Set<string> {
    return flowStructureUtil
        .getAllSteps(flowVersion.trigger)
        .filter(isTyrboBrowserStep)
        .reduce((names, step) => names.add(step.name), new Set<string>())
}

export async function aggregateTyrboCloudBrowserMs({ steps, browserStepNames, fetchSlice }: AggregateParams): Promise<number> {
    const resolved = await resolveTyrboStepOutputs({ steps, stepNames: browserStepNames, fetchSlice })
    return resolved.reduce((total, { output }) => total + cloudDurationMs(output[TYRBO_BROWSER_MARKER_KEY]), 0)
}

function isTyrboBrowserStep(step: Step): boolean {
    return step.type === FlowActionType.PIECE && step.settings.pieceName === TYRBO_BROWSER_PIECE_NAME
}

function cloudDurationMs(marker: unknown): number {
    if (typeof marker !== 'object' || isNil(marker) || Array.isArray(marker)) {
        return 0
    }
    const record = marker as Record<string, unknown>
    if (record['execution'] !== 'cloud') {
        return 0
    }
    const durationMs = record['durationMs']
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        return 0
    }
    return Math.floor(durationMs)
}

type AggregateParams = {
    steps: Record<string, StepOutput>
    browserStepNames: Set<string>
    fetchSlice: SliceFetcher
}
