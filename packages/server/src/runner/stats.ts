import { emptyRunStats, type RunStats, type Status, type TopVacancy, type Vacancy } from "@sgz/shared";

export interface StatsCollector {
  found(n: number): void;
  deduped(n?: number): void;
  record(status: Status, v?: Pick<Vacancy, "title" | "company" | "salaryFrom" | "salaryTo" | "url">): void;
  chatReply(): void;
  invitation(): void;
  rejection(): void;
  llmCall(n?: number): void;
  snapshot(): RunStats;
}

export function createStats(dryRun: boolean): StatsCollector {
  const s = emptyRunStats(dryRun);
  const sent: TopVacancy[] = [];
  return {
    found: (n) => void (s.found += n),
    deduped: (n = 1) => void (s.deduped += n),
    record(status, v) {
      s.by_status[status] = (s.by_status[status] ?? 0) + 1;
      if (status === "SENT" && v) sent.push({ title: v.title, company: v.company, salary_from: v.salaryFrom, salary_to: v.salaryTo, url: v.url });
    },
    chatReply: () => void (s.chat_replies += 1),
    invitation: () => void (s.invitations += 1),
    rejection: () => void (s.rejections += 1),
    llmCall: (n = 1) => void (s.llm_calls += n),
    snapshot() {
      const top = [...sent].sort((a, b) => b.salary_from - a.salary_from || b.salary_to - a.salary_to).slice(0, 3);
      return { ...s, by_status: { ...s.by_status }, top_vacancies: top };
    },
  };
}

/** Sum of several per-user snapshots into one run-level RunStats. */
export function mergeStats(parts: RunStats[], dryRun: boolean): RunStats {
  const out = emptyRunStats(dryRun);
  const top: TopVacancy[] = [];
  for (const p of parts) {
    out.found += p.found;
    out.deduped += p.deduped;
    out.chat_replies += p.chat_replies;
    out.invitations += p.invitations;
    out.rejections += p.rejections;
    out.llm_calls += p.llm_calls;
    for (const [k, v] of Object.entries(p.by_status)) out.by_status[k as Status] = (out.by_status[k as Status] ?? 0) + (v ?? 0);
    top.push(...p.top_vacancies);
  }
  out.top_vacancies = top.sort((a, b) => b.salary_from - a.salary_from).slice(0, 3);
  return out;
}

export const sentCount = (s: RunStats): number => s.by_status.SENT ?? 0;
export const skippedCount = (s: RunStats): number =>
  Object.entries(s.by_status).reduce((acc, [k, v]) => (k.startsWith("SKIP_") ? acc + (v ?? 0) : acc), 0);
export const failedCount = (s: RunStats): number =>
  Object.entries(s.by_status).reduce((acc, [k, v]) => (k.startsWith("FAILED_") ? acc + (v ?? 0) : acc), 0);
