import {
    FlowActionType,
    FlowVersion,
    LogSliceRef,
    StepOutput,
    StepOutputStatus,
    StepOutputType,
} from '@activepieces/shared'
import { describe, expect, it } from 'vitest'
import {
    aggregateTyrboCloudBrowserMs,
    TYRBO_BROWSER_PIECE_NAME,
    tyrboBrowserStepNames,
} from '../../../../src/app/tyrbo/tyrbo-browser-usage'

// Minimal flow-version graph: webhook trigger -> step chain via nextAction.
function flowVersionWith(...actions: Record<string, unknown>[]): FlowVersion {
    let next: Record<string, unknown> | undefined = undefined
    for (const action of [...actions].reverse()) {
        next = { ...action, nextAction: next }
    }
    return {
        id: 'fv1',
        flowId: 'flow1',
        displayName: 'test',
        valid: true,
        state: 'DRAFT',
        trigger: {
            name: 'trigger',
            displayName: 'Webhook',
            type: 'WEBHOOK',
            valid: true,
            settings: {},
            nextAction: next,
        },
    } as unknown as FlowVersion
}

function browserAction(name: string): Record<string, unknown> {
    return {
        name,
        displayName: name,
        type: FlowActionType.PIECE,
        valid: true,
        settings: { pieceName: TYRBO_BROWSER_PIECE_NAME, actionName: 'run', input: {} },
    }
}

function pieceAction(name: string, pieceName: string): Record<string, unknown> {
    return {
        name,
        displayName: name,
        type: FlowActionType.PIECE,
        valid: true,
        settings: { pieceName, actionName: 'whatever', input: {} },
    }
}

function loopAction(name: string, child: Record<string, unknown>): Record<string, unknown> {
    return {
        name,
        displayName: name,
        type: FlowActionType.LOOP_ON_ITEMS,
        valid: true,
        settings: { items: '{{trigger.body}}' },
        firstLoopAction: child,
    }
}

function browserOutput(marker: Record<string, unknown> | undefined, extra: Partial<StepOutput> = {}): StepOutput {
    return {
        type: FlowActionType.PIECE,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output: { scraped: 'ok', ...(marker ? { $run: marker } : {}) },
        ...extra,
    } as unknown as StepOutput
}

const CLOUD_MARKER = { status: 'ok', execution: 'cloud', workerId: 'w1', timedOut: false, durationMs: 1234 }
const LOCAL_MARKER = { status: 'ok', execution: 'local', workerId: 'device-1', timedOut: false, durationMs: 999 }

const noSlices = async (): Promise<unknown> => {
    throw new Error('unexpected slice fetch')
}

describe('tyrboBrowserStepNames', () => {
    it('collects only @tyrbo/piece-browser steps, including inside loops', () => {
        const flowVersion = flowVersionWith(
            pieceAction('step_1', '@activepieces/piece-slack'),
            loopAction('step_2', browserAction('step_3')),
            browserAction('step_4'),
        )
        expect(tyrboBrowserStepNames(flowVersion)).toEqual(new Set(['step_3', 'step_4']))
    })

    it('is empty for flows without browser steps', () => {
        const flowVersion = flowVersionWith(pieceAction('step_1', '@activepieces/piece-slack'))
        expect(tyrboBrowserStepNames(flowVersion).size).toBe(0)
    })
})

describe('aggregateTyrboCloudBrowserMs', () => {
    it('sums durationMs across cloud groups only', async () => {
        const total = await aggregateTyrboCloudBrowserMs({
            steps: {
                step_1: browserOutput(CLOUD_MARKER),
                step_2: browserOutput(LOCAL_MARKER),
                step_3: browserOutput({ ...CLOUD_MARKER, durationMs: 766 }),
            },
            browserStepNames: new Set(['step_1', 'step_2', 'step_3']),
            fetchSlice: noSlices,
        })
        expect(total).toBe(2000)
    })

    it('never counts groups without an execution tag (pre-v0.2.0 piece outputs)', async () => {
        const { execution, ...untagged } = CLOUD_MARKER
        expect(execution).toBe('cloud')
        const total = await aggregateTyrboCloudBrowserMs({
            steps: { step_1: browserOutput(untagged) },
            browserStepNames: new Set(['step_1']),
            fetchSlice: noSlices,
        })
        expect(total).toBe(0)
    })

    it('sums cloud iterations inside loops', async () => {
        const iteration = (durationMs: number): Record<string, StepOutput> => ({
            step_2: browserOutput({ ...CLOUD_MARKER, durationMs }),
        })
        const total = await aggregateTyrboCloudBrowserMs({
            steps: {
                step_1: {
                    type: FlowActionType.LOOP_ON_ITEMS,
                    status: StepOutputStatus.SUCCEEDED,
                    output: { iterations: [iteration(100), iteration(200), iteration(300)] },
                } as unknown as StepOutput,
            },
            browserStepNames: new Set(['step_2']),
            fetchSlice: noSlices,
        })
        expect(total).toBe(600)
    })

    it('resolves SLICE outputs through the slice fetcher', async () => {
        const sliceRef = { fileId: 'file_1' }
        const total = await aggregateTyrboCloudBrowserMs({
            steps: {
                step_1: browserOutput(undefined, {
                    outputType: StepOutputType.SLICE,
                    output: sliceRef as LogSliceRef,
                } as Partial<StepOutput>),
            },
            browserStepNames: new Set(['step_1']),
            fetchSlice: async (ref) => {
                expect(ref).toEqual(sliceRef)
                return { scraped: 'big output', $run: CLOUD_MARKER }
            },
        })
        expect(total).toBe(1234)
    })

    it('skips failed steps, non-browser steps and malformed durations', async () => {
        const total = await aggregateTyrboCloudBrowserMs({
            steps: {
                step_1: browserOutput(CLOUD_MARKER, { status: StepOutputStatus.FAILED } as Partial<StepOutput>),
                step_2: browserOutput({ ...CLOUD_MARKER, durationMs: -5 }),
                step_3: browserOutput({ ...CLOUD_MARKER, durationMs: Number.NaN }),
                step_4: browserOutput({ ...CLOUD_MARKER, durationMs: '1234' }),
                step_5: browserOutput(undefined),
                // non-browser step with a colliding $run-shaped output is
                // ignored: only steps whose flow-version pieceName matches
                // are read.
                step_6: browserOutput(CLOUD_MARKER),
            },
            browserStepNames: new Set(['step_1', 'step_2', 'step_3', 'step_4', 'step_5']),
            fetchSlice: noSlices,
        })
        expect(total).toBe(0)
    })

    it('floors fractional durations', async () => {
        const total = await aggregateTyrboCloudBrowserMs({
            steps: { step_1: browserOutput({ ...CLOUD_MARKER, durationMs: 10.9 }) },
            browserStepNames: new Set(['step_1']),
            fetchSlice: noSlices,
        })
        expect(total).toBe(10)
    })
})
