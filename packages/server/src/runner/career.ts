// Career-site stages for one user: onboard → discover → dedup → fetch → decide → tailor CV (browser
// closed) → build PDF → cover letter → QUEUED for human review. Nothing is submitted automatically:
// the panel starts stage send:<id> (submit) or inspect:<id> (fill the form, don't submit) per item.
import { mkdirSync } from "node:fs";
import { paths, RunAbortError, Status, type Answer, type CV, type CareerSite, type Decision, type Discovered, type Question, type Vacancy } from "@sgz/shared";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { classify, titleScore, companyLimitSettings, createRunCompanyTracker, ensureVacancy, isoDaysAgo, recordSkip, rejectWindowDays, skeletonVacancy, type RunCompanyTracker } from "./filters.js";
import { isStop, newApp } from "./hh.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";

/** Title keywords for sites without their own `profile.filters`: dev roles only, so a 3000-job board
 * doesn't feed sales or warehouse postings into tailoring. */
export const DEFAULT_CAREER_KEYWORDS = ["разработчик", "developer", "программист", "engineer", "go", "golang", "backend", "бэкенд", "бекенд", "back-end", "frontend", "фронтенд", "front-end", "fullstack", "full-stack", "фулстек", "фуллстек", "node.js", "nodejs", "node", "react", "vue", "typescript", "javascript", "python",
  // wider "any interview" roles
  "devops", "sre", "mlops", "ml", "data", "platform", "qa", "автоматизации тестирования", "автотестов", "автотестирования", "инфраструктуры", "инфраструктурный",
  // transliterated slugs (sitemap-based clients)
  "razrabotchik", "programmist"];
import { errMessage } from "./util.js";

export interface CareerPlan {
  /** Only onboard this site id (stage `onboard:<id>`); null = normal flow. */
  onboardOnly: number | null;
  discover: boolean;
  apply: boolean;
  /** Stage send:<id> / inspect:<id> (one QUEUED application) or force:<id> (a filtered-out one → queue). */
  target: { applicationId: number; mode: "send" | "inspect" | "force" | "retailor" } | null;
  /** Stage `rotate`: a few least-recently-visited sites not yet visited today (the serve autopilot's chunk). */
  rotate: boolean;
}

/** Sites still to visit today and the remaining career budget, for the autopilot's `rotate` chunks. */
export function careerRotation(store: RunContext["store"], user: UserRun["user"], tz: string, now: Date): { sites: CareerSite[]; budget: number } {
  const day = dayInTz(now, tz);
  const enabled = store.listCareerSites(user.id, true).filter((s) => s.ats !== "hh_hosted");
  const budget = dailyBudget(store, user, enabled.map((s) => s.slug), user.dailyLimitCareer, 0, day);
  const sites = enabled
    .filter((s) => !s.lastRunAt || dayInTz(new Date(s.lastRunAt), tz) !== day)
    .sort((a, b) => (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? ""));
  return { sites, budget };
}

export async function runCareerUser(ctx: RunContext, u: UserRun, plan: CareerPlan): Promise<void> {
  const { user } = u;
  const career = ctx.deps.career;
  if (!career) {
    ctx.log.warn("discover", "career agent not configured, skipping career sites");
    return;
  }
  if (plan.target?.mode === "force") return forceQueue(ctx, u, plan.target.applicationId);
  if (plan.target?.mode === "retailor") return retailorQueued(ctx, u, plan.target.applicationId);
  if (plan.target) return reviewQueued(ctx, u, plan.target);
  // Least recently visited first, so a small daily budget still rotates through every site.
  let sites = ctx.store
    .listCareerSites(user.id, true)
    .filter((s) => plan.onboardOnly === null || s.id === plan.onboardOnly)
    .sort((a, b) => (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? ""));
  if (plan.rotate) {
    const r = careerRotation(ctx.store, user, ctx.cfg.tz, ctx.now());
    if (r.budget <= 0) return ctx.log.info("discover", "career: daily limit reached, nothing to rotate");
    const n = Number(ctx.store.getSetting("career_sites_per_run") || 1) || 1;
    sites = r.sites.slice(0, n);
  }
  if (!sites.length) {
    ctx.log.info("discover", plan.onboardOnly !== null ? `career site ${plan.onboardOnly} not found or disabled` : "no enabled career sites");
    return;
  }
  const day = dayInTz(ctx.now(), ctx.cfg.tz);
  let budget = dailyBudget(ctx.store, user, sites.map((s) => s.slug), user.dailyLimitCareer, ctx.req.limit, day);
  ctx.log.info("discover", `career: ${sites.length} sites, budget ${budget}`, { budget });

  // Shared across sites so the company quota/persona lock applies across e.g. Ozon's own careers
  // page and Ozon vacancies found through hh in the same run.
  const companyTracker = createRunCompanyTracker();

  for (let site of sites) {
    ctx.checkAbort();
    if (site.ats === "hh_hosted") {
      ctx.log.info("discover", `${site.name}: hh-hosted, handled by the hh pipeline`);
      continue;
    }
    // CSV imports carry profile.notes, so "never onboarded" = no listing_url yet.
    const needsOnboard = plan.onboardOnly !== null || !site.profile?.listing_url;
    if (needsOnboard) {
      const s = await ctx.browser.open(user);
      ctx.log.info(`onboard:${site.id}`, `${site.name}: onboarding ${site.baseUrl}`);
      let r: Awaited<ReturnType<typeof career.onboard>>;
      try {
        r = await career.onboard(s, site.baseUrl, site.profile?.notes);
      } catch (e) {
        if (e instanceof RunAbortError || isStop(e)) throw e;
        ctx.log.error(`onboard:${site.id}`, `${site.name}: onboarding failed: ${errMessage(e)}`, { site_id: site.id });
        // Mark it visited so the autopilot's rotation moves on instead of retrying it every chunk.
        if (!ctx.req.dryRun) ctx.store.upsertCareerSite({ ...site, lastRunAt: ctx.now().toISOString() });
        continue;
      }
      const onboarded = { ...site, ats: r.ats, profile: { ...r.profile, last_verified_at: ctx.now().toISOString() } };
      // Onboarding is useful during a dry run, but persisting learned settings is
      // a mutation and would make a simulation affect the next real run.
      site = ctx.req.dryRun ? onboarded : ctx.store.upsertCareerSite(onboarded);
      ctx.log.info(`onboard:${site.id}`, `${site.name}: ats=${site.ats}, apply_mode=${site.profile.apply_mode ?? "?"}`, { ats: site.ats });
      if (plan.onboardOnly !== null) continue;
    }
    if (!plan.discover) continue;
    try {
      // Spread wide: at most career_per_site vacancies per site per run.
      const cap = Math.min(budget, Number(ctx.store.getSetting("career_per_site") || 3) || 3);
      budget -= cap - (await runSite(ctx, u, site, cap, plan.apply, companyTracker));
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.error("discover", `${site.name}: ${errMessage(e)}`, { site_id: site.id });
    }
    if (!ctx.req.dryRun) ctx.store.upsertCareerSite({ ...site, lastRunAt: ctx.now().toISOString() });
  }
}

async function runSite(ctx: RunContext, u: UserRun, site: CareerSite, budget: number, doApply: boolean, companyTracker: RunCompanyTracker): Promise<number> {
  const { user, profile, stats } = u;
  const career = ctx.deps.career!;
  // Discovery needs a browser only for sites without a client; applying opens its own session later.
  const session = site.ats === "custom" ? await ctx.browser.open(user) : null;
  const discovered = await career.discover(session, site, site.profile.filters?.length ? site.profile.filters : DEFAULT_CAREER_KEYWORDS);
  stats.found(discovered.length);
  ctx.log.info("discover", `${site.name}: ${discovered.length} vacancies`, { site_id: site.id, found: discovered.length });

  const rawDedupDays = Number(ctx.store.getSetting("dedup_window_days"));
  const dedupSince = isoDaysAgo(ctx.now(), Number.isFinite(rawDedupDays) && rawDedupDays >= 0 ? rawDedupDays : 60);
  const rejectSince = isoDaysAgo(ctx.now(), rejectWindowDays(ctx.store, 30));
  const company = companyLimitSettings(ctx.store);
  const companySince = isoDaysAgo(ctx.now(), company.windowDays);
  const candidates: { d: Discovered; vacancy: Vacancy; companyKey: string; lockedDirection: string }[] = [];
  for (const d of discovered) {
    const vacancy = ensureVacancy(ctx.store, skeletonVacancy(site.slug, d.externalId, d.url, d.title, d.company || site.name));
    const c = classify(ctx.store, user, profile, vacancy, { dedupSinceISO: dedupSince, rejectSinceISO: rejectSince, company, companySinceISO: companySince, runTracker: companyTracker });
    if (c.kind === "sent") continue;
    if (c.kind === "skip") {
      if (c.status === Status.SKIP_DEDUP) stats.deduped();
      stats.record(c.status);
      recordSkip(ctx.store, newApp(ctx, user.id, vacancy.id, c.status, c.detail));
      continue;
    }
    candidates.push({ d, vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
  }
  if (budget <= 0) {
    ctx.log.info("discover", `${site.name}: ${candidates.length} candidates but daily limit reached`);
    return budget;
  }

  // Sites list in their own order (alphabetical, by department): fetch the most relevant titles first.
  candidates.sort((a, b) => titleScore(b.d.title, profile) - titleScore(a.d.title, profile));
  const fetched: { vacancy: Vacancy; companyKey: string; lockedDirection: string }[] = [];
  for (const c of candidates.slice(0, budget * 2 + 2)) {
    ctx.checkAbort();
    try {
      const v = ctx.store.upsertVacancy({ ...(await career.fetch(session, site, c.d)), id: c.vacancy.id });
      if (v.hasTest) {
        stats.record(Status.SKIP_TEST_REQUIRED);
        ctx.store.insertApplication(newApp(ctx, user.id, v.id, Status.SKIP_TEST_REQUIRED, ""));
      } else fetched.push({ vacancy: v, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("discover", `${c.d.title}: fetch failed: ${errMessage(e)}`);
    }
    if (session) await ctx.throttle.afterRead();
  }
  if (!doApply || !fetched.length) {
    ctx.log.info("discover", `${site.name}: ${fetched.length} fetched`, { fetched: fetched.length });
    return budget;
  }

  // Same gate as hh before spending a tailored CV: Claude decides by level, stack and role.
  await ctx.memoryGuard("decide");
  const decisions = await ctx.llm.decide({ profile, resumes: ctx.store.listHHResumes(user.id), vacancies: fetched.map((f) => f.vacancy) });
  stats.llmCall(Math.ceil(fetched.length / 10));
  const verdict = new Map(decisions.map((d) => [d.vacancy_id, d]));
  const approved = fetched.filter((f) => {
    const d = verdict.get(f.vacancy.id);
    if (d?.apply) return true;
    stats.record(Status.SKIP_LLM_REJECT);
    ctx.store.insertApplication({ ...newApp(ctx, user.id, f.vacancy.id, Status.SKIP_LLM_REJECT, d?.reason ?? "no decision"), llmDecision: d ?? null });
    return false;
  });
  ctx.log.info("decide", `${site.name}: ${approved.length} approved of ${fetched.length}`, { approved: approved.length, fetched: fetched.length });
  fetched.splice(0, fetched.length, ...approved);
  if (!fetched.length) return budget;

  if (!ctx.deps.resume) {
    ctx.log.warn("tailor", "resume toolchain not available, cannot apply to career sites");
    return budget;
  }

  for (const { vacancy, companyKey, lockedDirection } of fetched) {
    ctx.checkAbort();
    if (budget <= 0) {
      stats.record(Status.SKIP_LIMIT);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, Status.SKIP_LIMIT, "run limit reached (daily or per site)"));
      continue;
    }
    // Re-check right before tailoring/sending: earlier vacancies this run may have already used up
    // the company's quota, or locked it to a different CV direction.
    if (companyKey && company.maxSent > 0) {
      const total = ctx.store.countRecentApplicationsByCompany(user.id, companyKey, companySince) + companyTracker.count(companyKey);
      if (total >= company.maxSent) {
        stats.record(Status.SKIP_COMPANY_LIMIT);
        ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, Status.SKIP_COMPANY_LIMIT, `company limit reached: ${total}/${company.maxSent} sent in ${company.windowDays}d`));
        continue;
      }
    }
    const effectiveLock = company.personaLockEnabled ? lockedDirection || companyTracker.lockedDirection(companyKey) : "";
    const q = await queueVacancy(ctx, u, vacancy, effectiveLock, verdict.get(vacancy.id) ?? null);
    if (!q) continue;
    if (companyKey) companyTracker.reserve(companyKey, q.direction);
    if (q.status === Status.QUEUED) budget--;
  }
  return budget;
}

/** One vacancy → base CV (honouring the company's persona lock) → tailored CV → PDF → cover letter →
 * QUEUED for review (SKIP_DRY_RUN on a dry run). Failures are recorded as application rows; null = nothing queued. */
async function queueVacancy(ctx: RunContext, u: UserRun, vacancy: Vacancy, effectiveLock: string, decision: Decision | null): Promise<{ status: Status; direction: string } | null> {
  const { user, profile, stats } = u;
  const resume = ctx.deps.resume;
  if (!resume) {
    ctx.log.warn("tailor", "resume toolchain not available, cannot apply to career sites");
    return null;
  }
  const picked = pickBaseCV(ctx, user.slug, profile.directions, effectiveLock);
  if (!picked) {
    if (effectiveLock) {
      stats.record(Status.SKIP_COMPANY_PERSONA);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, Status.SKIP_COMPANY_PERSONA, `company locked to direction "${effectiveLock}", no matching base CV`));
    } else {
      ctx.log.warn("tailor", `no base CV in ${paths.cvDir(ctx.cfg, user.slug)} (expected base-<direction>.yaml)`);
    }
    return null;
  }
  const base = await resume.loadCV(picked.path);
  const tier = user.opusEnabled ? "tailor" : "write";
  await ctx.browser.close();
  let cv: CV;
  let pdfPath: string;
  let generatedId: number;
  let coverLetter: string;
  try {
    await ctx.memoryGuard("tailor");
    ctx.log.info("tailor", `${vacancy.title} @ ${vacancy.company}: tailoring (${tier})`, { vacancy_id: vacancy.id });
    const t = await ctx.llm.tailorCV(profile, base, vacancy, tier);
    stats.llmCall();
    cv = t.cv;
    const violations = resume.validateCV(base, cv, profile.never_claim_skills);
    if (violations.length) {
      stats.record(Status.FAILED_LLM);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, Status.FAILED_LLM, `cv validation: ${violations.join("; ")}`));
      ctx.log.error("tailor", `${vacancy.title}: tailored CV rejected: ${violations.join("; ")}`, { vacancy_id: vacancy.id });
      return null;
    }
    const tex = resume.renderTex(cv);
    await ctx.memoryGuard("build");
    const outDir = paths.generatedDir(ctx.cfg, user.slug);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      /* fake fs in tests / read-only dir: buildPdf will report */
    }
    const built = await resume.buildPdf({ tex, texDir: paths.texDir(ctx.cfg), outPdf: `${outDir}/${vacancy.id}.pdf`, xelatexBin: ctx.cfg.xelatexBin });
    pdfPath = built.pdfPath;
    generatedId = ctx.store.insertGeneratedResume({ userId: user.id, vacancyId: vacancy.id, texPath: built.texPath, pdfPath, model: tier }).id;
    ctx.log.info("build", `${vacancy.title}: pdf ready`, { vacancy_id: vacancy.id, pdf: pdfPath });
    coverLetter = await ctx.llm.coverLetterCareer(profile, cv, vacancy);
    stats.llmCall();
  } catch (e) {
    if (e instanceof RunAbortError || isStop(e)) throw e;
    const status = /xelatex|latex/i.test(errMessage(e)) ? Status.FAILED_LATEX : Status.FAILED_LLM;
    stats.record(status);
    ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, status, errMessage(e)));
    ctx.log.error("build", `${vacancy.title}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
    return null;
  }

  // Career sites never auto-submit: the ready CV + letter wait in the panel's review queue
  // (stage send:<id> / inspect:<id> below). A dry run only reports what would be queued.
  const status = ctx.req.dryRun ? Status.SKIP_DRY_RUN : Status.QUEUED;
  ctx.store.insertApplication({
    ...newApp(ctx, user.id, vacancy.id, status, ctx.req.dryRun ? "dry run: would queue for review" : ""),
    coverLetter,
    generatedResumeId: generatedId,
    direction: picked.direction,
    llmDecision: decision,
  });
  stats.record(status, vacancy);
  ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${status}`, { vacancy_id: vacancy.id, status });
  return { status, direction: picked.direction };
}

/** Stage send:<id> / inspect:<id>: submit one QUEUED application, or open its form without submitting
 * and store the extra questions + the answers the bot would give. */
async function reviewQueued(ctx: RunContext, u: UserRun, review: NonNullable<CareerPlan["target"]>): Promise<void> {
  const { user, profile, stats } = u;
  const career = ctx.deps.career!;
  const id = review.applicationId;
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== user.id) return ctx.log.error("apply", `application ${id} not found for ${user.slug}`);
  const { application: app, vacancy } = row;
  if (app.status !== Status.QUEUED) return ctx.log.warn("apply", `application ${id} is ${app.status}, not queued`);
  let site = ctx.store.listCareerSites(user.id).find((x) => x.slug === vacancy.source);
  const pdf = app.generatedResumeId ? ctx.store.getGeneratedResume(app.generatedResumeId) : null;
  if (!site || !pdf) return ctx.log.error("apply", `application ${id}: ${!site ? `site ${vacancy.source} not found` : "no generated CV"}`);
  const inspect = review.mode === "inspect" || ctx.req.dryRun;
  ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${inspect ? "checking form" : "sending"}`, { vacancy_id: vacancy.id, application_id: id });

  let questions: Question[] | undefined;
  let answers: Answer[] | undefined;
  try {
    const s = await ctx.browser.open(user);
    const r = await career.apply(s, {
      site,
      vacancy,
      profile,
      resumePdfPath: pdf.pdfPath,
      coverLetter: app.coverLetter,
      dryRun: inspect,
      answerQuestions: async (qs) => {
        questions = qs;
        answers = await ctx.llm.answerQuestionnaire(profile, vacancy, qs);
        stats.llmCall();
        return answers;
      },
    });
    const qs = r.questions ?? questions;
    const as = r.answers ?? answers;
    ctx.store.deleteQuestionnaireAnswers(id);
    if (qs?.length && as?.length) ctx.store.insertQuestionnaireAnswers(id, qs, as);
    if (inspect) ctx.store.updateApplicationStatus(id, Status.QUEUED, `form checked: ${qs?.length ?? 0} question(s)${r.status === Status.SKIP_DRY_RUN ? "" : ` · ${r.status}`}${r.reasonDetail ? ` · ${r.reasonDetail}` : ""}`);
    else {
      ctx.store.updateApplicationStatus(id, r.status, r.reasonDetail);
      stats.record(r.status, vacancy);
    }
    if (r.learnedHints && !ctx.req.dryRun) site = ctx.store.upsertCareerSite({ ...site, profile: { ...site.profile, apply_hints: r.learnedHints } });
    ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${inspect ? "form checked" : r.status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status: r.status });
  } catch (e) {
    if (e instanceof RunAbortError || isStop(e)) throw e;
    if (inspect) ctx.store.updateApplicationStatus(id, Status.QUEUED, `form check failed: ${errMessage(e)}`);
    else {
      ctx.store.updateApplicationStatus(id, Status.FAILED_UI, errMessage(e));
      stats.record(Status.FAILED_UI, vacancy);
    }
    ctx.log.error("apply", `${vacancy.title}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
  }
}

/** Stage force:<id>: the human overrode a filter / LLM reject. Skips filters, limits and the decide
 * gate and runs the normal tailor → PDF → letter path into the review queue. */
async function forceQueue(ctx: RunContext, u: UserRun, id: number): Promise<void> {
  const { user } = u;
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== user.id) return ctx.log.error("apply", `application ${id} not found for ${user.slug}`);
  const { application: app } = row;
  let vacancy = row.vacancy;
  if (ctx.store.hasSentApplication(user.id, vacancy.id)) return ctx.log.warn("apply", `${vacancy.title}: already queued or sent`);
  const site = ctx.store.listCareerSites(user.id).find((x) => x.slug === vacancy.source);
  if (!site) return ctx.log.error("apply", `application ${id}: site ${vacancy.source} not found`);
  if (!vacancy.descriptionText) {
    // Filtered before fetch (title filter, dedup, company limit): only the listing card is stored.
    const session = site.ats === "custom" ? await ctx.browser.open(user) : null;
    const d: Discovered = { externalId: vacancy.externalId, url: vacancy.url, title: vacancy.title, company: vacancy.company };
    try {
      vacancy = ctx.store.upsertVacancy({ ...(await ctx.deps.career!.fetch(session, site, d)), id: vacancy.id });
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      return ctx.log.error("fetch", `${vacancy.title}: fetch failed: ${errMessage(e)}`, { vacancy_id: vacancy.id });
    }
  }
  const was = `forced by user (was ${app.status}${app.reasonDetail ? `: ${app.reasonDetail}` : ""})`;
  const decision: Decision = { ...(app.llmDecision ?? { vacancy_id: vacancy.id, resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] }), apply: true, reason: was };
  ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${was}`, { vacancy_id: vacancy.id, application_id: id });
  await queueVacancy(ctx, u, vacancy, "", decision);
}

/** Stage retailor:<id>: a fresh tailored CV + letter for a QUEUED item. The old row is retired only once the
 * new one is queued (a failed rebuild keeps it), as SKIP_DEDUP so it doesn't use a daily queue slot. */
async function retailorQueued(ctx: RunContext, u: UserRun, id: number): Promise<void> {
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== u.user.id) return ctx.log.error("apply", `application ${id} not found for ${u.user.slug}`);
  if (row.application.status !== Status.QUEUED) return ctx.log.warn("apply", `application ${id} is ${row.application.status}, not queued`);
  ctx.log.info("apply", `${row.vacancy.title} @ ${row.vacancy.company}: rebuilding CV and letter`, { application_id: id });
  const q = await queueVacancy(ctx, u, row.vacancy, "", row.application.llmDecision ?? null);
  if (q?.status === Status.QUEUED) ctx.store.updateApplicationStatus(id, Status.SKIP_DEDUP, "пересобрано: новая версия в очереди");
}

/** Prefer `wantDirection` (the company's persona lock) if a matching base CV exists; else the profile's own order. */
function pickBaseCV(ctx: RunContext, slug: string, directions: string[], wantDirection: string): { path: string; direction: string } | null {
  const dir = paths.cvDir(ctx.cfg, slug);
  const order = wantDirection ? [wantDirection] : [...directions, ""];
  for (const d of order) {
    const p = d ? `${dir}/base-${d}.yaml` : `${dir}/base.yaml`;
    if (ctx.fileExists(p)) return { path: p, direction: d };
  }
  return null;
}
