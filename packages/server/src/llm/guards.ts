// Deterministic post-checks on model output. The prompt asks; these enforce.
import type { Decision, HHResume, Vacancy } from "@sgz/shared";

// URLs, t.me, @handles, emails, host/path (a real TLD: «Node.js/TypeScript» is a stack, not a link), bare profile
// hosts, RU/international phones.
const LINK_RE =
  /https?:\/\/|www\.|\bt\.me\b|@[a-z0-9_]{4,}|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|com|org|net|io|dev|me|app|su|info|pro|co|рф)\/|\b(?:github|gitlab|bitbucket|linkedin|habr|leetcode|vk|telegram)\.(?:com|ru|org|me)\b|\+\d[\d\s()-]{8,}\d|\b8[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/i;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}]/gu;
const SENTENCE_RE = /[^.!?\n]+(?:[.!?]+|\n|$)/g;

export const LIMITS = {
  coverLetterHH: 1500,
  coverLetterCareer: 1500,
  chatReply: 1000,
  questionnaireText: 500,
  bullet: 220,
  about: 700,
  reason: 300,
} as const;

export function splitSentences(text: string): string[] {
  // Protect dots inside URLs while finding sentence boundaries. Otherwise
  // `https://host/path` leaves fragments such as `com/path` behind.
  const marker = "\uE000";
  // Dots inside words and versions ("Node.js", "Go 1.18", "2.5 года") are not sentence ends either.
  // A leading dot of a name (« .NET», « .env») is not one either.
  const protectedText = text.replace(/([\p{L}\d])\.(?=[\p{L}\d])/gu, `$1${marker}`).replace(/(^|\s)\.(?=\p{L})/gu, `$1${marker}`).replace(/(?:https?:\/\/|www\.|t\.me\/)[^\s]+/gi, (url) => {
      const core = url.replace(/[.!?,;:]+$/, "");
      return core.replace(/\./g, marker) + url.slice(core.length);
    });
  const sentences = (protectedText.match(SENTENCE_RE) ?? [])
    .map((s) => s.replaceAll(marker, ".").trim())
    .filter(Boolean);
  // Keep short Cyrillic abbreviations (e.g. `См.`) with the following text.
  const out: string[] = [];
  for (const sentence of sentences) {
    if (out.length && /^[\p{Script=Cyrillic}]{1,3}\.$/u.test(out[out.length - 1]!)) out[out.length - 1] += ` ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

export function stripLinkSentences(text: string): string {
  return joinSentences(splitSentences(text).filter((s) => !LINK_RE.test(s)));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary match that works for Cyrillic (JS \b is ASCII-only). */
export function claimRegex(tokens: string[]): RegExp | null {
  const parts = tokens.map((t) => t.trim()).filter(Boolean).map(escapeRe);
  if (!parts.length) return null;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${parts.join("|")})(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

// An honest «X в продакшене не использовал» / «с X не работал, но готов освоить» / «опыта с X нет» is what the
// prompts ask for; it is not a claim. «не было» alone («с X не было проблем») is one, so it counts only next to прод.
const DENIAL_RE =
  /(?:^|[^\p{L}])(?:не\s+(?:использовал|применял|работал|довелось|доводилось|пробовал|приходилось)|нет\s+(?:\p{L}+\s+)?опыта|не\s+было\s+(?:\p{L}+\s+)?опыта|опыта(?:\s+[\p{L}\p{N}.+#-]+){0,4}\s+нет)(?=$|[^\p{L}])/iu;
const isDenial = (s: string) =>
  DENIAL_RE.test(s) || (/(?:^|[^\p{L}])не\s+было(?=$|[^\p{L}])/iu.test(s) && /(?:^|[^\p{L}])(?:проде?|продакшене?|продакшн|production)(?=$|[^\p{L}])/iu.test(s));

export function stripNeverClaimSentences(text: string, never: string[]): string {
  const re = claimRegex(never);
  if (!re) return text;
  return joinSentences(splitSentences(text).filter((s) => !re.test(s) || isDenial(s)));
}

/** Truncate at a sentence boundary when possible; hard-cut otherwise. */
export function enforceMax(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = splitSentences(text);
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  return out || text.slice(0, max).trimEnd();
}

/** Em-dash → hyphen, emoji out, bullet markers out, whitespace normalized. */
export function normalizeProse(text: string): string {
  return text
    .replace(/[—–]/g, " - ")
    .replace(EMOJI_RE, "")
    .replace(/(^|[^\p{L}])(в|В)люсь(?=[^\p{L}]|$)/gu, "$1$2ливаюсь") // a recurring model typo («легко влюсь в команду»)
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Well-known technologies a letter may only mention when the seeker lists them in verified_skills. */
const COMMON_TECH = [
  "Kubernetes", "k8s", "Kafka", "RabbitMQ", "ClickHouse", "Elasticsearch", "MongoDB", "Cassandra", "Java", "Kotlin", "Scala",
  "C#", ".NET", "PHP", "Laravel", "Ruby", "Rust", "C++", "Swift", "1C", "Terraform", "Ansible", "AWS", "GCP", "Azure", "gRPC",
  "Airflow", "Spark", "Hadoop", "Angular", "Svelte", "Flutter", "Unity", "Oracle", "MySQL", "Jenkins", "OpenShift",
];

/** never_claim plus every common technology the profile doesn't verify: nothing unverified gets claimed in writing. */
export function blockedTech(p: { verified_skills: string[]; never_claim_skills: string[] }): string[] {
  // A token is verified when it appears as a word in any verified skill ("AWS S3" → AWS, "Apache Kafka" → Kafka).
  const verified = (t: string) => p.verified_skills.some((s) => claimRegex([t])!.test(s));
  const alias: Record<string, string> = { k8s: "Kubernetes", kubernetes: "k8s" };
  const alt = (t: string) => alias[t.toLowerCase()];
  return [...p.never_claim_skills, ...COMMON_TECH.filter((t) => !verified(t) && !(alt(t) && verified(alt(t)!)))];
}

/** Everything a letter or chat reply must satisfy, in one call. Line breaks and paragraphs are kept. */
export function sanitizeLetter(text: string, never: string[], max: number): string {
  const cleaned = normalizeProse(text)
    .split("\n")
    .map((line) => (line.trim() ? stripNeverClaimSentences(stripLinkSentences(line), never) : ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return enforceMax(cleaned, max);
}

function joinSentences(sentences: string[]): string {
  return sentences.join(" ").replace(/ +/g, " ").trim();
}

export function pickResumeId(candidate: string, direction: string, pool: HHResume[]): string {
  if (!pool.length) return "";
  if (pool.some((r) => r.hhResumeId === candidate)) return candidate;
  const dir = direction.trim().toLowerCase();
  const byDir = dir
    ? pool.find((r) => r.direction.toLowerCase() === dir || r.summary?.direction.toLowerCase() === dir)
    : undefined;
  return (byDir ?? pool[0]!).hhResumeId;
}

export function ensureDecisions(vacancies: Vacancy[], decisions: Decision[], pool: HHResume[], never: string[]): Decision[] {
  const byId = new Map<number, Decision>();
  for (const d of decisions) if (!byId.has(d.vacancy_id)) byId.set(d.vacancy_id, d);
  return vacancies.map((v) => {
    const d = byId.get(v.id);
    if (!d) {
      return { vacancy_id: v.id, apply: false, reason: "no decision", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] };
    }
    return {
      ...d,
      reason: enforceMax(d.reason, LIMITS.reason),
      resume_id: pickResumeId(d.resume_id, d.direction, pool),
      cover_letter: d.apply ? sanitizeLetter(d.cover_letter, never, LIMITS.coverLetterHH) : "",
    };
  });
}
