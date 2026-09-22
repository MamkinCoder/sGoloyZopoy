// Greenhouse Job Board API (verified 2026-09 against docs.greenhouse.io/job-board.html + live board).
// Reading is public. POSTing an application needs the board's Job Board API key (HTTP Basic), so
// `apply` is only attempted when GREENHOUSE_BOARD_API_KEY is set; otherwise the agent flow applies.
import { Status } from "@sgz/shared";
import type { CareerApplyRequest, CareerApplyResult, Discovered, Question } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, httpFetch, pathSegments, stripHtml } from "../http.js";
import { makeVacancy, toISO } from "../vacancy.js";
import { answerValues, basicAuth, byIdx, fileFromPath, splitName } from "./apply-common.js";
import { atsId, firstMatch, rawId, slugRe, type ATSClientImpl } from "./types.js";

const API = "https://boards-api.greenhouse.io/v1/boards";

export interface GHJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string } | null;
  content?: string; // HTML, entity-escaped
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  questions?: GHQuestion[];
  location_questions?: GHQuestion[];
}
export interface GHQuestion {
  label: string;
  required: boolean;
  fields: { name: string; type: string; values?: { label: string; value: string | number }[] }[];
}

const STANDARD = new Set(["first_name", "last_name", "email", "phone", "resume", "resume_text", "cover_letter", "cover_letter_text"]);

const HOSTS = /(^|\.)(job-boards|boards)(\.eu)?\.greenhouse\.io$/;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (HOSTS.test(hostOf(baseUrl))) {
    const segs = pathSegments(baseUrl);
    const forParam = firstMatch(baseUrl, [/[?&]for=([a-z0-9_.-]+)/i]);
    if (forParam) return { token: forParam };
    if (segs[0] && segs[0] !== "embed") return { token: segs[0] };
  }
  const token = firstMatch(html, [
    new RegExp(`greenhouse\\.io/embed/job_board(?:/js)?\\?for=(${slugRe})`, "i"),
    new RegExp(`boards-api\\.greenhouse\\.io/v1/boards/(${slugRe})`, "i"),
    new RegExp(`(?:job-boards|boards)(?:\\.eu)?\\.greenhouse\\.io/(${slugRe})`, "i"),
  ]);
  if (!token || token === "embed" || token === "v1") return null;
  return { token };
}

const toDiscovered = (job: GHJob): Discovered => ({
  externalId: atsId("greenhouse", job.id),
  url: job.absolute_url,
  title: job.title,
  company: job.company_name ?? "",
  location: job.location?.name ?? undefined,
  raw: job,
});

async function listJobs(token: string): Promise<Discovered[]> {
  const data = await getJson<{ jobs: GHJob[] }>(`${API}/${token}/jobs?content=true`);
  return (data.jobs ?? []).map(toDiscovered);
}

const descriptionOf = (job: GHJob): string => stripHtml(decodeEntities(job.content ?? ""));

async function fetchJob(token: string, d: Discovered) {
  const cached = d.raw as GHJob | undefined;
  const job = cached?.content !== undefined ? cached : await getJson<GHJob>(`${API}/${token}/jobs/${rawId(d.externalId)}`);
  return makeVacancy({
    source: "greenhouse",
    externalId: d.externalId,
    url: job.absolute_url ?? d.url,
    title: job.title ?? d.title,
    company: job.company_name ?? d.company,
    descriptionText: descriptionOf(job),
    area: job.location?.name ?? d.location ?? "",
    publishedAt: toISO(job.first_published ?? job.updated_at),
  });
}

function kindOf(type: string): Question["kind"] | null {
  switch (type) {
    case "input_text":
    case "textarea":
      return "text";
    case "input_file":
      return "file";
    case "multi_value_single_select":
      return "radio";
    case "multi_value_multi_select":
      return "checkbox";
    default:
      return null;
  }
}

/**
 * Maps the board's custom questions to our Question[]; returns null when a required question cannot be
 * expressed (unknown type / extra file upload) so the caller falls back to the agent flow.
 */
export function mapQuestions(job: GHJob): { questions: Question[]; fieldNames: string[] } | null {
  const questions: Question[] = [];
  const fieldNames: string[] = [];
  for (const q of [...(job.questions ?? []), ...(job.location_questions ?? [])]) {
    for (const f of q.fields) {
      if (STANDARD.has(f.name) || f.type === "input_hidden") continue;
      const kind = kindOf(f.type);
      if (kind === null || kind === "file") {
        if (q.required) return null;
        continue;
      }
      questions.push({
        idx: questions.length,
        text: q.label,
        kind,
        options: f.values?.map((v) => v.label),
        required: q.required,
      });
      fieldNames.push(f.name);
    }
  }
  return { questions, fieldNames };
}

async function apply(token: string, req: CareerApplyRequest): Promise<CareerApplyResult | null> {
  const key = process.env.GREENHOUSE_BOARD_API_KEY ?? "";
  if (!key) return null;
  const jobId = rawId(req.vacancy.externalId);
  const job = await getJson<GHJob>(`${API}/${token}/jobs/${jobId}?questions=true`);
  const mapped = mapQuestions(job);
  if (!mapped) return null;

  const answers = mapped.questions.length ? await req.answerQuestions(mapped.questions) : [];
  const answered = byIdx(answers);
  const fd = new FormData();
  const { first, last } = splitName(req.profile.full_name);
  fd.append("first_name", first);
  fd.append("last_name", last || first);
  fd.append("email", req.profile.email);
  if (req.profile.phone) fd.append("phone", req.profile.phone);
  fd.append("resume", await fileFromPath(req.resumePdfPath));
  if (req.coverLetter) fd.append("cover_letter_text", req.coverLetter);

  for (const q of mapped.questions) {
    const values = answerValues(q, answered.get(q.idx));
    const field = mapped.fieldNames[q.idx] as string;
    const gh = job.questions?.concat(job.location_questions ?? []).flatMap((x) => x.fields).find((f) => f.name === field);
    if (values.length === 0) {
      if (q.required) return null;
      continue;
    }
    if (q.kind === "text") {
      fd.append(field, values[0] as string);
      continue;
    }
    const optionValue = (label: string) => String(gh?.values?.find((v) => v.label === label)?.value ?? label);
    if (q.kind === "checkbox") for (const v of values) fd.append(`${field}[]`, optionValue(v));
    else fd.append(field, optionValue(values[0] as string));
  }

  if (req.dryRun) {
    return { status: Status.SKIP_DRY_RUN, reasonDetail: "greenhouse api dry run", questions: mapped.questions, answers };
  }
  const res = await httpFetch(`${API}/${token}/jobs/${jobId}`, {
    method: "POST",
    headers: { authorization: basicAuth(key) },
    body: fd,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { status: Status.FAILED_NO_CONFIRMATION, reasonDetail: `greenhouse api HTTP ${res.status}: ${text.slice(0, 300)}`, questions: mapped.questions, answers };
  }
  return { status: Status.SENT, reasonDetail: "greenhouse api", questions: mapped.questions, answers };
}

export const greenhouse: ATSClientImpl = {
  kind: "greenhouse",
  verified: true,
  notes: "list/detail public; apply via API needs GREENHOUSE_BOARD_API_KEY (HTTP Basic), else agent flow",
  jobsUrl: (token) => `${API}/${token}/jobs?content=true`,
  detect,
  listJobs,
  fetchJob,
  apply,
};
