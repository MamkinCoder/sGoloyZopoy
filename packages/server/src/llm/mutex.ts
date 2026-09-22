// Process-wide mutex: the Pi cannot afford two `claude` node processes at once.

export interface Mutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly pending: number;
}

export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      pending++;
      const next = tail.then(fn, fn).finally(() => pending--);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export const claudeMutex: Mutex = createMutex();
