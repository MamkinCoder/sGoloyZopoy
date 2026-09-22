// In-memory fan-out of run events: every subscriber gets the events published so far (replay)
// and then live ones; the iterator ends when the run is closed.
import type { RunEvent } from "@sgz/shared";

const REPLAY_CAP = 5000;
const KEEP_CLOSED = 5;

interface Sub {
  queue: RunEvent[];
  wake: (() => void) | null;
}
interface Channel {
  events: RunEvent[];
  subs: Set<Sub>;
  closed: boolean;
}

export class EventHub {
  private readonly channels = new Map<number, Channel>();

  open(runId: number): void {
    this.channels.set(runId, { events: [], subs: new Set(), closed: false });
    const closed = [...this.channels.entries()].filter(([, c]) => c.closed);
    for (const [id] of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) this.channels.delete(id);
  }

  publish(runId: number, ev: RunEvent): void {
    const ch = this.channels.get(runId);
    if (!ch || ch.closed) return;
    ch.events.push(ev);
    if (ch.events.length > REPLAY_CAP) ch.events.shift();
    for (const s of ch.subs) {
      s.queue.push(ev);
      s.wake?.();
    }
  }

  close(runId: number): void {
    const ch = this.channels.get(runId);
    if (!ch) return;
    ch.closed = true;
    for (const s of ch.subs) s.wake?.();
  }

  isOpen(runId: number): boolean {
    const ch = this.channels.get(runId);
    return !!ch && !ch.closed;
  }

  subscribe(runId: number): AsyncIterable<RunEvent> {
    const ch = this.channels.get(runId);
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        if (!ch) return (async function* () {})();
        const sub: Sub = { queue: [...ch.events], wake: null };
        if (!ch.closed) ch.subs.add(sub);
        const gen = (async function* () {
          try {
            for (;;) {
              const next = sub.queue.shift();
              if (next) {
                yield next;
                continue;
              }
              if (ch.closed) return;
              await new Promise<void>((r) => (sub.wake = r));
              sub.wake = null;
            }
          } finally {
            ch.subs.delete(sub);
          }
        })();
        void self;
        return gen;
      },
    };
  }
}
