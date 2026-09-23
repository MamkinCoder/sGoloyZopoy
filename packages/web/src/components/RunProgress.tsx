import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { useRun } from "../api/hooks";
import { isRunActive, RUN_STATUS_LABEL } from "../lib/status";
import { toast } from "../lib/toast";
import { RunStatusBadge } from "./StatusBadge";

/** Toast for a failed send/inspect/force start: 409 means another run is in progress. */
export function runStartError(e: unknown) {
  toast.error(e instanceof ApiError && e.status === 409 ? "Занято, попробуйте через минуту" : e instanceof Error ? e.message : String(e));
}

/** Status of a run started from a card; refetches the queue / filtered lists once it finishes. */
export function RunProgress({ slug, runId }: { slug: string; runId: number }) {
  const run = useRun(runId);
  const qc = useQueryClient();
  const status = run.data?.status;
  const done = status !== undefined && !isRunActive(status);
  useEffect(() => {
    if (!done || !status) return;
    toast.info(`run #${runId}: ${RUN_STATUS_LABEL[status]}`);
    qc.invalidateQueries({ queryKey: ["queue"] });
    qc.invalidateQueries({ queryKey: ["filtered"] });
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] muted">
      <Link to={`/u/${slug}/runs/${runId}`}>run #{runId}</Link>
      {status ? <RunStatusBadge status={status} /> : "…"}
    </span>
  );
}
