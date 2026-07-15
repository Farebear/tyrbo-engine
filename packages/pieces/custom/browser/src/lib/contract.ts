// TYRBO-PATCH: @tyrbo/piece-browser (fork patch #5, additive piece).
//
// Queue contract with the browser-run executors. SOURCE OF TRUTH:
// Farebear/tyrbo apps/browser-worker/src/contract.ts — this is a mirrored
// copy (the repos cannot share a workspace import). Bump
// JOB_CONTRACT_VERSION in BOTH places on any breaking change so a stale
// producer/consumer pair fails loudly instead of misbehaving.

/** Cloud fleet queue (BullMQ on the engine Redis). */
export const BROWSER_RUNS_QUEUE = 'browser-runs';

/**
 * Per-device queue for `execution: local` steps, bridged to the desktop app
 * by tyrbo's device-relay (M7). Dot separator — BullMQ rejects `:` in queue
 * names (queue-base validation), so the PLAN's original `device:{deviceId}`
 * could never be created; caught by the M7 e2e. Mirrors
 * Farebear/tyrbo packages/run-contract.
 */
export function deviceQueueName(deviceId: string): string {
  return `device.${deviceId}`;
}

export const JOB_CONTRACT_VERSION = 1;

/** One authored browser step; validated strictly by the consumer. */
export type BrowserStepLike = Record<string, unknown>;

export interface BrowserRunInput {
  execution: 'cloud' | 'local';
  program: BrowserStepLike[];
}

export interface BrowserRunJobData {
  v: typeof JOB_CONTRACT_VERSION;
  runId: string;
  projectId: string;
  flowId?: string;
  stepName?: string;
  input: BrowserRunInput;
  sessionKey?: string;
  baseUrl?: string;
  variables?: Record<string, unknown>;
}

export interface BrowserRunStepResult {
  stepId: string;
  action: string;
  status: 'ok' | 'failed' | 'skipped';
  attempts: number;
  durationMs: number;
  healed: boolean;
  selectorUsed?: { strategy: string; value: string };
  output?: unknown;
  error?: string;
  artifacts: { name: string; contentType: string; size: number; uri: string }[];
}

export interface BrowserRunJobResult {
  v: typeof JOB_CONTRACT_VERSION;
  workerId: string;
  status: 'ok' | 'failed';
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: {
    status: 'ok' | 'failed';
    steps: BrowserRunStepResult[];
    variables: Record<string, unknown>;
    outputs: Record<string, unknown>;
  };
}
