import type { Logger, RunEvent, Store } from "@sgz/shared";
import type { EventHub } from "./hub.js";

export function createRunLogger(store: Store, hub: EventHub, runId: number, stderr: (line: string) => void = console.error): Logger {
  const emit = (level: RunEvent["level"], stage: string, message: string, data?: Record<string, unknown>) => {
    let ev: RunEvent;
    try {
      ev = store.appendRunEvent({ runId, level, stage, message, data });
    } catch (e) {
      ev = { id: 0, runId, ts: new Date().toISOString(), level, stage, message, data };
      stderr(`[run ${runId}] [logger] appendRunEvent failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    hub.publish(runId, ev);
    const suffix = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
    stderr(`[run ${runId}] ${level === "info" ? "" : level.toUpperCase() + " "}[${stage}] ${message}${suffix}`);
  };
  return {
    info: (stage, message, data) => emit("info", stage, message, data),
    warn: (stage, message, data) => emit("warn", stage, message, data),
    error: (stage, message, data) => emit("error", stage, message, data),
  };
}
