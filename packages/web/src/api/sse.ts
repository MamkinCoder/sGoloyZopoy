import type { RunEventDTO } from "@sgz/shared";

export interface RunStreamHandlers {
  onEvent: (e: RunEventDTO) => void;
  onDone: () => void;
  onStatus?: (s: "connecting" | "open" | "reconnecting") => void;
}

export interface RunStream {
  close: () => void;
}

/**
 * Live log of a run over SSE. The browser resends `Last-Event-ID` on its own reconnects
 * (the server sets `id:` per event); on a hard close we reopen with `?after=<lastId>` and
 * drop anything already seen, so the caller never gets duplicates.
 */
export function streamRunEvents(runId: number, after: number, h: RunStreamHandlers): RunStream {
  let lastId = after;
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    if (closed) return;
    h.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    es = new EventSource(`/api/runs/${runId}/events/stream?after=${lastId}`, { withCredentials: true });
    es.onopen = () => {
      attempt = 0;
      h.onStatus?.("open");
    };
    es.addEventListener("run_event", (ev) => {
      const e = JSON.parse((ev as MessageEvent<string>).data) as RunEventDTO;
      if (e.id <= lastId) return;
      lastId = e.id;
      h.onEvent(e);
    });
    es.addEventListener("done", () => {
      closed = true;
      es?.close();
      h.onDone();
    });
    es.onerror = () => {
      if (closed || !es) return;
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        attempt += 1;
        const delay = Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4));
        timer = window.setTimeout(open, delay);
      }
    };
  };
  open();

  return {
    close: () => {
      closed = true;
      window.clearTimeout(timer);
      es?.close();
    },
  };
}
