// Process-wide limit on concurrent `claude` processes (~225 MB each). The Pi (1.8 GB) fits two while the
// browser is closed (decide batches); SGZ_CLAUDE_PARALLEL=1 restores strict one-at-a-time.

export interface Mutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly pending: number;
}

/** A counting semaphore: at most `slots` tasks run at once, the rest wait in FIFO order. */
export function createMutex(slots = 1): Mutex {
  let running = 0;
  let pending = 0;
  const waiting: (() => void)[] = [];
  return {
    get pending() {
      return pending;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      pending++;
      if (running >= slots) await new Promise<void>((r) => waiting.push(r));
      running++;
      try {
        return await fn();
      } finally {
        running--;
        pending--;
        waiting.shift()?.();
      }
    },
  };
}

/** SGZ_CLAUDE_PARALLEL: how many `claude` processes may run at once (the agent sizes its LLM lane by it too). */
export const CLAUDE_PARALLEL = Math.max(1, Number(process.env.SGZ_CLAUDE_PARALLEL ?? 2) || 1);
export const claudeMutex: Mutex = createMutex(CLAUDE_PARALLEL);
