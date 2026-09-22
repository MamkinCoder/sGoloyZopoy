// Career-site contract. Workstream F implements: ATS JSON clients (no browser) + a universal
// Stagehand flow (onboard / discover / apply) driven by SiteProfile hints that the agent maintains.
import type { BrowserSession } from "./browser.js";
import type { ATSKind, Answer, CareerSite, Profile, Question, SiteProfile, Status, Vacancy } from "./model.js";

export interface Discovered {
  externalId: string; // canonical URL (or ATS job id prefixed by ats)
  url: string;
  title: string;
  company: string;
  location?: string;
  raw?: unknown;
}

export interface CareerApplyRequest {
  site: CareerSite;
  vacancy: Vacancy;
  profile: Profile;
  resumePdfPath: string;
  coverLetter: string;
  dryRun: boolean;
  answerQuestions: (qs: Question[]) => Promise<Answer[]>;
}

export interface CareerApplyResult {
  status: Status;
  reasonDetail: string;
  snapshotPath?: string;
  questions?: Question[];
  answers?: Answer[];
  /** Hints the agent wants stored back into SiteProfile.apply_hints (self-healing). */
  learnedHints?: string;
}

/** One ATS family (greenhouse, lever, ...). No browser needed. */
export interface ATSClient {
  kind: ATSKind;
  /** Detect from a careers URL / page HTML; returns board token if this ATS. */
  detect(baseUrl: string, html: string): { token: string } | null;
  listJobs(token: string): Promise<Discovered[]>;
  fetchJob(token: string, d: Discovered): Promise<Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">>;
  /** Apply via the ATS public API when it exists; return null if unsupported (then agent flow is used). */
  apply?(token: string, req: CareerApplyRequest): Promise<CareerApplyResult | null>;
}

export interface CareerAgent {
  /** One-time: visit baseUrl, figure out ATS / listing / apply flow; returns a SiteProfile. */
  onboard(s: BrowserSession, baseUrl: string, hints?: string): Promise<{ ats: ATSKind; profile: SiteProfile }>;
  /** Daily: list vacancies. Uses ATS JSON when profile has it, else the agent + discover_hints. */
  discover(s: BrowserSession | null, site: CareerSite, filters: string[]): Promise<Discovered[]>;
  fetch(s: BrowserSession | null, site: CareerSite, d: Discovered): Promise<Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">>;
  apply(s: BrowserSession, req: CareerApplyRequest): Promise<CareerApplyResult>;
}
