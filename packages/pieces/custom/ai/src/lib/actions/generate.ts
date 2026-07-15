// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import { clampMaxTokens, resolveModel } from '../models';
import { AiDeps, completeText } from '../providers';
import { asText, maxTokensProp, modelProp, outputVariableProp, withUsageMarker } from './common';

export interface GenerateProps {
  instruction: unknown;
  outputVariable?: unknown;
  model?: unknown;
  maxTokens?: unknown;
}

export async function runGenerate(props: GenerateProps, deps?: AiDeps): Promise<Record<string, unknown>> {
  const model = resolveModel(props.model);
  const { text, usage } = await completeText(
    {
      model,
      system: 'Follow the instruction. Reply with the requested text only — no preamble.',
      prompt: asText(props.instruction, 'instruction'),
      maxTokens: clampMaxTokens(props.maxTokens),
    },
    deps,
  );
  return withUsageMarker(props.outputVariable, 'text', text, model, usage);
}

export const generate = createAction({
  name: 'generate',
  displayName: 'Generate Text',
  description: 'Generate text from an instruction (Tyrbo-metered AI)',
  props: {
    instruction: Property.LongText({
      displayName: 'Instruction',
      description: 'What to write; supports {{vars}} from earlier steps',
      required: true,
    }),
    outputVariable: outputVariableProp(),
    model: modelProp(),
    maxTokens: maxTokensProp(),
  },
  async run(context) {
    return runGenerate(context.propsValue);
  },
});
