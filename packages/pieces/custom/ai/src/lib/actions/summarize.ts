// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import { clampMaxTokens, resolveModel } from '../models';
import { AiDeps, completeText } from '../providers';
import {
  fileUrlProp,
  maxTokensProp,
  modelProp,
  outputVariableProp,
  resolveDocument,
  resolvePrompt,
  withUsageMarker,
} from './common';

export interface SummarizeProps {
  input?: unknown;
  fileUrl?: unknown;
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
    'Summarize the input. Reply with the summary only — no preamble.',
    ...(style ? [`Style: ${style}.`] : []),
  ].join(' ');
  const document = await resolveDocument({ fileUrl: props.fileUrl, deps });
  const { text, usage } = await completeText(
    {
      model,
      system,
      prompt: resolvePrompt({
        document,
        input: props.input,
        documentInstruction: 'Summarize the attached document.',
      }),
      document,
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
      description:
        'The text to summarize; supports {{vars}}. Optional when "File URL" is set (then treated as extra instructions)',
      required: false,
    }),
    fileUrl: fileUrlProp(),
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
