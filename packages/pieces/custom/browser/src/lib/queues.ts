// TYRBO-PATCH: @tyrbo/piece-browser (fork patch #5, additive piece).
//
// BullMQ producer plumbing. The piece runs inside the engine worker process
// (AP_EXECUTION_MODE=UNSANDBOXED on the Tyrbo fleet), so it reads the same
// AP_REDIS_* environment the engine itself uses (mirrors
// server/api database/redis/default-redis.ts, minus the SSL CA file case).
// Queue/QueueEvents instances are cached per queue name for the lifetime of
// the worker process: QueueEvents holds a blocking subscriber connection,
// and loops enqueue one job per iteration — churning connections per step
// would hammer the (flat-cost, but still) self-hosted Redis.

import { Queue, QueueEvents } from 'bullmq';
import Redis, { RedisOptions } from 'ioredis';

const BASE_OPTIONS: Partial<RedisOptions> = {
  maxRetriesPerRequest: null,
  keepAlive: 5000,
};

export function createRedisClient(): Redis {
  const url = process.env.AP_REDIS_URL;
  if (url) {
    return new Redis(url, BASE_OPTIONS);
  }
  const host = process.env.AP_REDIS_HOST;
  const port = process.env.AP_REDIS_PORT;
  if (!host || !port) {
    throw new Error(
      '@tyrbo/piece-browser: AP_REDIS_URL or AP_REDIS_HOST/AP_REDIS_PORT must be set (the engine queue Redis)'
    );
  }
  return new Redis({
    ...BASE_OPTIONS,
    host,
    port: Number.parseInt(port, 10),
    username: process.env.AP_REDIS_USER,
    password: process.env.AP_REDIS_PASSWORD,
    db: process.env.AP_REDIS_DB ? Number.parseInt(process.env.AP_REDIS_DB, 10) : 0,
    tls: process.env.AP_REDIS_USE_SSL === 'true' ? {} : undefined,
  });
}

const queues = new Map<string, Queue>();
const queueEvents = new Map<string, QueueEvents>();

export function queueFor(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createRedisClient() });
    queues.set(name, queue);
  }
  return queue;
}

export function queueEventsFor(name: string): QueueEvents {
  let events = queueEvents.get(name);
  if (!events) {
    events = new QueueEvents(name, { connection: createRedisClient() });
    queueEvents.set(name, events);
  }
  return events;
}
