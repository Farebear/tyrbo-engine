// TYRBO-PATCH: @tyrbo/piece-ai (fork patch #7, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import { clampMaxTokens, resolveModel } from '../models';
import { AiDeps, completeJson } from '../providers';
import { asRecord, asText, maxTokensProp, modelProp, outputVariableProp, withUsageMarker } from './common';

const SYSTEM = [
  'Extract structured data from the input.',
  'Fill every schema field from the input text; use null when the information is not present.',
  'Never invent values.',
].join(' ');

/**
 * `shape` is a field → description map (the authoring/AI-builder contract,
 * Farebear/tyrbo packages/ai-builder mock catalog), or a full JSON Schema
 * object for hand-authored steps.
 */
export function shapeToJsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  const looksLikeJsonSchema =
    shape['type'] === 'object' && typeof shape['properties'] === 'object' && shape['properties'] !== null;
  if (looksLikeJsonSchema) {
    const { type: _type, ...rest } = shape;
    return rest;
  }
  return {
    properties: Object.fromEntries(
      Object.entries(shape).map(([field, description]) => [
        field,
        { description: typeof description === 'string' ? description : JSON.stringify(description) },
      ]),
    ),
    required: Object.keys(shape),
    additionalProperties: false,
  };
}

export interface ExtractProps {
  input: unknown;
  shape: unknown;
  outputVariable?: unknown;
  model?: unknown;
  maxTokens?: unknown;
}

export async function runExtractStructuredData(
  props: ExtractProps,
  deps?: AiDeps,
): Promise<Record<string, unknown>> {
  const model = resolveModel(props.model);
  const shape = asRecord(props.shape);
  if (!shape || Object.keys(shape).length === 0) {
    throw new Error(
      '@tyrbo/piece-ai: "shape" must be a non-empty object (field name → description of what to extract)',
    );
  }
  const { json, usage } = await completeJson(
    {
      model,
      system: SYSTEM,
      prompt: asText(props.input, 'input'),
      maxTokens: clampMaxTokens(props.maxTokens),
      schemaName: 'extraction',
      schema: shapeToJsonSchema(shape),
    },
    deps,
  );
  return withUsageMarker(props.outputVariable, 'data', json, model, usage);
}

export const extractStructuredData = createAction({
  name: 'extractStructuredData',
  displayName: 'Extract Structured Data',
  description: 'Turn a document/page/text into JSON matching a shape (Tyrbo-metered AI)',
  props: {
    input: Property.LongText({
      displayName: 'Input',
      description: 'The source text; supports {{vars}} from earlier steps',
      required: true,
    }),
    shape: Property.Json({
      displayName: 'Shape',
      description:
        'Field name → description of what to extract (or a JSON Schema object with type/properties)',
      required: true,
    }),
    outputVariable: outputVariableProp(),
    model: modelProp(),
    maxTokens: maxTokensProp(),
  },
  async run(context) {
    return runExtractStructuredData(context.propsValue);
  },
});
