// Process-wide limit on concurrent `claude` processes (~225 MB each). The Pi (1.8 GB) fits two while the
// browser is closed (decide batches); SGZ_CLAUDE_PARALLEL=1 restores strict one-at-a-time.
import { AsyncLocalStorage } from "node:async_hooks";

export interface MutexRunOptions {
  /** Waits ahead of every non-priority task (agent jobs ahead of batch runs). */
  priority?: boolean;
  /** Called when the slot is taken, before `fn` runs. */
  onAcquire?(): void;
}

export interface Mutex {
  run<T>(fn: () => Promise<T>, o?: MutexRunOptions): Promise<T>;
  readonly pending: number;
}

/** A counting semaphore: at most `slots` tasks run at once, the rest wait in FIFO order (priority ones first). */
export function createMutex(slots = 1): Mutex {
  let running = 0;
  let pending = 0;
  const waiting: (() => void)[] = [];
  const urgent: (() => void)[] = [];
  return {
    get pending() {
      return pending;
    },
    async run<T>(fn: () => Promise<T>, o: MutexRunOptions = {}): Promise<T> {
      pending++;
      if (running >= slots) await new Promise<void>((r) => (o.priority ? urgent : waiting).push(r));
      running++;
      try {
        o.onAcquire?.();
        return await fn();
      } finally {
        running--;
        pending--;
        (urgent.shift() ?? waiting.shift())?.();
      }
    },
  };
}

/** SGZ_CLAUDE_PARALLEL: how many `claude` processes may run at once (the agent sizes its LLM lane by it too). */
export const CLAUDE_PARALLEL = Math.max(1, Number(process.env.SGZ_CLAUDE_PARALLEL ?? 2) || 1);
export const claudeMutex: Mutex = createMutex(CLAUDE_PARALLEL);

/** Who is calling `claude`, without threading it through every LLMClient method: the agent runs each job inside
 *  `llmCaller.run({priority, signal, onAcquire}, ...)`; runClaude passes it to the mutex and kills its child on abort. */
export const llmCaller = new AsyncLocalStorage<MutexRunOptions & { signal?: AbortSignal }>();
