// TYRBO-PATCH: @tyrbo/piece-browser (fork patch #5, additive piece).

import { createAction, Property } from '@activepieces/pieces-framework';
import {
  BROWSER_RUNS_QUEUE,
  BrowserRunJobData,
  BrowserRunJobResult,
  BrowserStepLike,
  deviceQueueName,
  JOB_CONTRACT_VERSION,
} from '../contract';
import { queueEventsFor, queueFor } from '../queues';
import { wakeBrowserPool } from '../wake';

/**
 * Wall-clock budget waiting for the job to return. Must stay under the
 * engine's per-flow timeout so a dead fleet fails this step cleanly instead
 * of timing out the whole run. Worker-side RUN_TIMEOUT_MS caps the browser
 * itself; the queue-wait allowance covers cold starts + queueing.
 */
function waitBudgetMs(): number {
  const run = Number.parseInt(process.env.TYRBO_BROWSER_RUN_TIMEOUT_MS ?? '300000', 10);
  const queueWait = Number.parseInt(process.env.TYRBO_BROWSER_QUEUE_WAIT_MS ?? '120000', 10);
  return run + queueWait;
}

function describeFailure(result: BrowserRunJobResult): string {
  const failed = result.result.steps.find((step) => step.status === 'failed');
  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(`run exceeded the ${result.durationMs}ms cap and was killed`);
  }
  if (failed) {
    parts.push(
      `step "${failed.stepId}" (${failed.action}) failed after ${failed.attempts} attempt(s): ${failed.error ?? 'unknown error'}`
    );
    if (failed.artifacts.length > 0) {
      parts.push(`artifacts: ${failed.artifacts.map((a) => a.uri).join(', ')}`);
    }
  }
  if (parts.length === 0) {
    parts.push('browser run failed with no step detail');
  }
  return `Browser run failed on worker ${result.workerId}: ${parts.join('; ')}`;
}

export const run = createAction({
  name: 'run',
  displayName: 'Run browser steps',
  description:
    'Executes a recorded browser sub-program (one Playwright session) on the Tyrbo cloud fleet or a linked device',
  props: {
    execution: Property.StaticDropdown({
      displayName: 'Execution',
      description: 'Where the browser runs: Tyrbo cloud fleet or a linked desktop device',
      required: true,
      defaultValue: 'cloud',
      options: {
        options: [
          { label: 'Cloud', value: 'cloud' },
          { label: 'Local device', value: 'local' },
        ],
      },
    }),
    program: Property.Json({
      displayName: 'Program',
      description: 'The compiled browser steps (authoring schema); one browser context survives the whole program',
      required: true,
    }),
    session: Property.ShortText({
      displayName: 'Session',
      description:
        'Named browser profile (storageState) to load before and save after a successful run; scoped to this project',
      required: false,
    }),
    deviceId: Property.ShortText({
      displayName: 'Device',
      description: 'Linked device id for local execution (required when Execution is "Local device")',
      required: false,
    }),
  },
  async run(context) {
    const { execution, program, session, deviceId } = context.propsValue;

    if (!Array.isArray(program) || program.length === 0) {
      throw new Error(
        '@tyrbo/piece-browser: "program" must be a non-empty array of browser steps (compiled authoring flow)'
      );
    }

    let queueName = BROWSER_RUNS_QUEUE;
    if (execution === 'local') {
      if (!deviceId) {
        throw new Error(
          'Local execution requires a linked device. Device routing ships with the desktop app (M7) — run this step in the cloud for now.'
        );
      }
      queueName = deviceQueueName(deviceId);
    }

    const jobData: BrowserRunJobData = {
      v: JOB_CONTRACT_VERSION,
      runId: context.run.id,
      projectId: context.project.id,
      flowId: context.flows.current.id,
      stepName: context.step.name,
      input: {
        execution: execution as BrowserRunJobData['input']['execution'],
        program: program as BrowserStepLike[],
      },
      sessionKey: session ? `${context.project.id}/${session}` : undefined,
    };

    const queue = queueFor(queueName);
    const job = await queue.add('browser.run', jobData, {
      // Browser actions are not idempotent — never auto-retry; failures
      // surface as step failures with artifacts.
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400 },
    });

    if (execution === 'cloud') {
      await wakeBrowserPool(queue);
    }

    const budget = waitBudgetMs();
    let result: BrowserRunJobResult;
    try {
      result = (await job.waitUntilFinished(queueEventsFor(queueName), budget)) as BrowserRunJobResult;
    } catch (error) {
      // Salvage the queue: a job nobody picked up would otherwise run as a
      // zombie after the flow already failed. remove() throws for active
      // jobs — that is fine, the worker's own run cap bounds those.
      await job.remove().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (/timed? ?out/i.test(message)) {
        throw new Error(
          `Browser run did not complete within ${budget}ms (queue "${queueName}"). ` +
            'The browser fleet may be down or saturated — check tyrbo-browser-worker machines and the browser-runs queue.'
        );
      }
      throw new Error(`Browser run failed in the queue: ${message}`);
    }

    if (result.v !== JOB_CONTRACT_VERSION) {
      throw new Error(
        `Browser worker returned contract v${result.v}, piece speaks v${JOB_CONTRACT_VERSION} — deploy matching versions`
      );
    }

    if (result.status !== 'ok') {
      throw new Error(describeFailure(result));
    }

    // Scrape outputs become the step output so downstream engine templates
    // resolve as {{step_N.<outputVariable>}}. $run carries diagnostics —
    // written after the spread so it always survives, and the compiler never
    // generates references starting with "$".
    return {
      ...result.result.outputs,
      $run: {
        status: result.status,
        workerId: result.workerId,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        steps: result.result.steps.map((step) => ({
          stepId: step.stepId,
          action: step.action,
          status: step.status,
          attempts: step.attempts,
          healed: step.healed,
          durationMs: step.durationMs,
          error: step.error,
          artifacts: step.artifacts.map((artifact) => artifact.uri),
        })),
      },
    };
  },
});
