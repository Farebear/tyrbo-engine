// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import { clampMaxTokens, resolveModel } from '../models';
import { AiDeps, completeText } from '../providers';
import { asText, maxTokensProp, modelProp, outputVariableProp, withUsageMarker } from './common';

export interface SummarizeProps {
  input: unknown;
  style?: unknown;
  outputVariable?: unknown;
  model?: unknown;
  maxTokens?: unknown;
}

export async function runSummarize(props: SummarizeProps, deps?: AiDeps): Promise<Record<string, unknown>> {
  const model = resolveModel(props.model);
  const style =
    typeof props.style === 'string' && props.style.trim().length > 0 ? props.style.trim() : undefined;
  const system = [
    'Summarize the input text. Reply with the summary only — no preamble.',
    ...(style ? [`Style: ${style}.`] : []),
  ].join(' ');
  const { text, usage } = await completeText(
    {
      model,
      system,
      prompt: asText(props.input, 'input'),
      maxTokens: clampMaxTokens(props.maxTokens),
    },
    deps,
  );
  return withUsageMarker(props.outputVariable, 'summary', text, model, usage);
}

export const summarize = createAction({
  name: 'summarize',
  displayName: 'Summarize',
  description: 'Summarize the input text (Tyrbo-metered AI)',
  props: {
    input: Property.LongText({
      displayName: 'Input',
      description: 'The text to summarize; supports {{vars}}',
      required: true,
    }),
    style: Property.ShortText({
      displayName: 'Style',
      description: "Optional style hint, e.g. 'one paragraph' or 'bullets'",
      required: false,
    }),
    outputVariable: outputVariableProp(),
    model: modelProp(),
    maxTokens: maxTokensProp(),
  },
  async run(context) {
    return runSummarize(context.propsValue);
  },
});
