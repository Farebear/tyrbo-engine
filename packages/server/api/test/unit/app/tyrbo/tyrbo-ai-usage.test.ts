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
    aggregateTyrboAiUsage,
    TYRBO_AI_PIECE_NAME,
    tyrboAiStepNames,
} from '../../../../src/app/tyrbo/tyrbo-ai-usage'

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

function aiAction(name: string): Record<string, unknown> {
    return {
        name,
        displayName: name,
        type: FlowActionType.PIECE,
        valid: true,
        settings: { pieceName: TYRBO_AI_PIECE_NAME, actionName: 'summarize', input: {} },
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

function aiOutput(marker: Record<string, unknown> | undefined, extra: Partial<StepOutput> = {}): StepOutput {
    return {
        type: FlowActionType.PIECE,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output: { summary: 'ok', ...(marker ? { $ai: marker } : {}) },
        ...extra,
    } as unknown as StepOutput
}

const MARKER = { provider: 'anthropic', model: 'claude-haiku-4-5', tokensIn: 120, tokensOut: 40 }

const noSlices = async (): Promise<unknown> => {
    throw new Error('unexpected slice fetch')
}

describe('tyrboAiStepNames', () => {
    it('collects only @tyrbo/piece-ai steps, including inside loops', () => {
        const flowVersion = flowVersionWith(
            pieceAction('step_1', '@activepieces/piece-slack'),
            loopAction('step_2', aiAction('step_3')),
            aiAction('step_4'),
        )
        expect(tyrboAiStepNames(flowVersion)).toEqual(new Set(['step_3', 'step_4']))
    })

    it('is empty for flows without AI steps', () => {
        const flowVersion = flowVersionWith(pieceAction('step_1', '@activepieces/piece-slack'))
        expect(tyrboAiStepNames(flowVersion).size).toBe(0)
    })
})

describe('aggregateTyrboAiUsage', () => {
    it('reads the $ai marker off a succeeded AI step', async () => {
        const entries = await aggregateTyrboAiUsage({
            steps: { step_1: aiOutput(MARKER) },
            aiStepNames: new Set(['step_1']),
            fetchSlice: noSlices,
        })
        expect(entries).toEqual([
            { stepName: 'step_1', provider: 'anthropic', model: 'claude-haiku-4-5', tokensIn: 120, tokensOut: 40, calls: 1 },
        ])
    })

    it('sums tokens across loop iterations into one entry per step', async () => {
        const iteration = (tokensIn: number, tokensOut: number): Record<string, StepOutput> => ({
            step_2: aiOutput({ ...MARKER, tokensIn, tokensOut }),
        })
        const entries = await aggregateTyrboAiUsage({
            steps: {
                step_1: {
                    type: FlowActionType.LOOP_ON_ITEMS,
                    status: StepOutputStatus.SUCCEEDED,
                    output: { iterations: [iteration(100, 10), iteration(200, 20), iteration(300, 30)] },
                } as unknown as StepOutput,
            },
            aiStepNames: new Set(['step_2']),
            fetchSlice: noSlices,
        })
        expect(entries).toEqual([
            { stepName: 'step_2', provider: 'anthropic', model: 'claude-haiku-4-5', tokensIn: 600, tokensOut: 60, calls: 3 },
        ])
    })

    it('resolves SLICE outputs through the slice fetcher', async () => {
        const sliceRef = { fileId: 'file_1' }
        const entries = await aggregateTyrboAiUsage({
            steps: {
                step_1: aiOutput(undefined, {
                    outputType: StepOutputType.SLICE,
                    output: sliceRef as LogSliceRef,
                } as Partial<StepOutput>),
            },
            aiStepNames: new Set(['step_1']),
            fetchSlice: async (ref) => {
                expect(ref).toEqual(sliceRef)
                return { summary: 'big output', $ai: MARKER }
            },
        })
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ stepName: 'step_1', tokensIn: 120, tokensOut: 40, calls: 1 })
    })

    it('skips failed steps, non-AI steps and malformed markers', async () => {
        const entries = await aggregateTyrboAiUsage({
            steps: {
                step_1: aiOutput(MARKER, { status: StepOutputStatus.FAILED } as Partial<StepOutput>),
                step_2: aiOutput({ provider: 'mistral', model: 'x', tokensIn: 1, tokensOut: 1 }),
                step_3: aiOutput({ ...MARKER, tokensIn: -5 }),
                step_4: aiOutput({ ...MARKER, tokensOut: Number.NaN }),
                step_5: aiOutput(undefined),
                // non-AI step with a colliding $ai-shaped output is ignored:
                // only steps whose flow-version pieceName matches are read.
                step_6: aiOutput(MARKER),
            },
            aiStepNames: new Set(['step_1', 'step_2', 'step_3', 'step_4', 'step_5']),
            fetchSlice: noSlices,
        })
        expect(entries).toEqual([])
    })

    it('floors fractional token counts', async () => {
        const entries = await aggregateTyrboAiUsage({
            steps: { step_1: aiOutput({ ...MARKER, tokensIn: 10.9, tokensOut: 2.2 }) },
            aiStepNames: new Set(['step_1']),
            fetchSlice: noSlices,
        })
        expect(entries[0]).toMatchObject({ tokensIn: 10, tokensOut: 2 })
    })
})
