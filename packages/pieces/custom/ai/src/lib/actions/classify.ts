// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import { clampMaxTokens, resolveModel } from '../models';
import { AiDeps, completeJson } from '../providers';
import { asText, maxTokensProp, modelProp, outputVariableProp, withUsageMarker } from './common';

const SYSTEM = 'Classify the input into exactly one of the allowed labels. Pick the single best match.';

export interface ClassifyProps {
  input: unknown;
  labels: unknown;
  outputVariable?: unknown;
  model?: unknown;
  maxTokens?: unknown;
}

function normalizeLabels(labels: unknown): string[] {
  const list = Array.isArray(labels) ? labels : undefined;
  const normalized = (list ?? [])
    .map((label) => (typeof label === 'string' ? label : String(label)))
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  if (normalized.length < 2) {
    throw new Error('@tyrbo/piece-ai: "labels" must list at least two labels to classify into');
  }
  return normalized;
}

export async function runClassify(props: ClassifyProps, deps?: AiDeps): Promise<Record<string, unknown>> {
  const model = resolveModel(props.model);
  const labels = normalizeLabels(props.labels);
  const { json, usage } = await completeJson(
    {
      model,
      system: SYSTEM,
      prompt: asText(props.input, 'input'),
      maxTokens: clampMaxTokens(props.maxTokens),
      schemaName: 'classification',
      schema: {
        properties: { label: { type: 'string', enum: labels } },
        required: ['label'],
        additionalProperties: false,
      },
    },
    deps,
  );
  const label = json['label'];
  if (typeof label !== 'string' || !labels.includes(label)) {
    throw new Error(
      `@tyrbo/piece-ai: the model answered outside the allowed labels (got ${JSON.stringify(label)})`,
    );
  }
  return withUsageMarker(props.outputVariable, 'label', label, model, usage);
}

export const classify = createAction({
  name: 'classify',
  displayName: 'Classify',
  description: 'Pick one label from a fixed set for the input (Tyrbo-metered AI)',
  props: {
    input: Property.LongText({
      displayName: 'Input',
      description: 'The text to classify; supports {{vars}}',
      required: true,
    }),
    labels: Property.Array({
      displayName: 'Labels',
      description: 'The allowed labels (at least two)',
      required: true,
    }),
    outputVariable: outputVariableProp(),
    model: modelProp(),
    maxTokens: maxTokensProp(),
  },
  async run(context) {
    return runClassify(context.propsValue);
  },
});
