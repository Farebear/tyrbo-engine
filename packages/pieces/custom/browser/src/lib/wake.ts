// TYRBO-PATCH: @tyrbo/piece-browser (fork patch #5, additive piece).
//
// Scale-to-zero wake: the browser-worker pool (Farebear/tyrbo
// apps/browser-worker) exits when idle so its Fly Machines STOP and cost
// ~$0 — someone has to start them again when work arrives, and the enqueue
// side is the only place that knows. Best-effort and env-gated: without
// TYRBO_BROWSER_POOL_APP + TYRBO_FLY_API_TOKEN (e.g. dev docker compose,
// golden flows, always-on workers) this is a no-op. Failures are logged and
// swallowed — a wake failure must never fail the user's run; a started
// worker or the next enqueue retries.

import { Queue } from 'bullmq';

const MACHINES_API = process.env.TYRBO_FLY_MACHINES_API ?? 'https://api.machines.dev';
const WAKE_THROTTLE_MS = 15_000;

let lastWakeAt = 0;

type FlyMachine = {
  id: string;
  state: string;
};

export async function wakeBrowserPool(queue: Queue): Promise<void> {
  const app = process.env.TYRBO_BROWSER_POOL_APP;
  const token = process.env.TYRBO_FLY_API_TOKEN;
  if (!app || !token) {
    return;
  }
  const now = Date.now();
  if (now - lastWakeAt < WAKE_THROTTLE_MS) {
    return;
  }
  lastWakeAt = now;

  try {
    const warmSpares = Number.parseInt(process.env.TYRBO_BROWSER_WARM_SPARES ?? '1', 10);
    const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
    const demand =
      (counts['waiting'] ?? 0) +
      (counts['prioritized'] ?? 0) +
      (counts['delayed'] ?? 0) +
      (counts['active'] ?? 0) +
      Math.max(warmSpares, 0);

    const headers = { Authorization: `Bearer ${token}` };
    const res = await fetch(`${MACHINES_API}/v1/apps/${app}/machines`, { headers });
    if (!res.ok) {
      throw new Error(`list machines: HTTP ${res.status}`);
    }
    const machines = (await res.json()) as FlyMachine[];
    const started = machines.filter((m) => m.state === 'started' || m.state === 'starting');
    const stopped = machines.filter((m) => m.state === 'stopped' || m.state === 'suspended');
    const deficit = Math.min(demand, machines.length) - started.length;

    for (const machine of stopped.slice(0, Math.max(deficit, 0))) {
      const start = await fetch(
        `${MACHINES_API}/v1/apps/${app}/machines/${machine.id}/start`,
        { method: 'POST', headers }
      );
      if (!start.ok) {
        throw new Error(`start machine ${machine.id}: HTTP ${start.status}`);
      }
      console.info(`[piece-browser] woke browser-worker machine ${machine.id} (${app})`);
    }
  } catch (error) {
    console.warn(
      `[piece-browser] browser pool wake failed (runs continue if a worker is up): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
