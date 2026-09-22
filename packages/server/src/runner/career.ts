// Career-site stages for one user: onboard → discover → dedup → fetch → tailor CV (browser closed)
// → build PDF → cover letter → apply. One vacancy at a time; the browser is reopened only to apply.
import { mkdirSync } from "node:fs";
import { paths, RunAbortError, Status, type Answer, type CV, type CareerSite, type Discovered, type Question, type Vacancy } from "@sgz/shared";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { classify, ensureVacancy, isoDaysAgo, skeletonVacancy } from "./filters.js";
import { isStop, newApp } from "./hh.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";
import { errMessage } from "./util.js";

export interface CareerPlan {
  /** Only onboard this site id (stage `onboard:<id>`); null = normal flow. */
  onboardOnly: number | null;
  discover: boolean;
  apply: boolean;
}

export async function runCareerUser(ctx: RunContext, u: UserRun, plan: CareerPlan): Promise<void> {
  const { user } = u;
  const career = ctx.deps.career;
  if (!career) {
    ctx.log.warn("discover", "career agent not configured, skipping career sites");
    return;
  }
  const sites = ctx.store.listCareerSites(user.id, true).filter((s) => plan.onboardOnly === null || s.id === plan.onboardOnly);
  if (!sites.length) {
    ctx.log.info("discover", plan.onboardOnly !== null ? `career site ${plan.onboardOnly} not found or disabled` : "no enabled career sites");
    return;
  }
  const day = dayInTz(ctx.now(), ctx.cfg.tz);
  let budget = dailyBudget(ctx.store, user, sites.map((s) => s.slug), user.dailyLimitCareer, ctx.req.limit, day);
  ctx.log.info("discover", `career: ${sites.length} sites, budget ${budget}`, { budget });

  for (let site of sites) {
    ctx.checkAbort();
    if (site.ats === "hh_hosted") {
      ctx.log.info("discover", `${site.name}: hh-hosted, handled by the hh pipeline`);
      continue;
    }
    const needsOnboard = plan.onboardOnly !== null || !site.profile || Object.keys(site.profile).length === 0;
    if (needsOnboard) {
      const s = await ctx.browser.open(user);
      ctx.log.info(`onboard:${site.id}`, `${site.name}: onboarding ${site.baseUrl}`);
      const r = await career.onboard(s, site.baseUrl, site.profile?.notes);
      const onboarded = { ...site, ats: r.ats, profile: { ...r.profile, last_verified_at: ctx.now().toISOString() } };
      // Onboarding is useful during a dry run, but persisting learned settings is
      // a mutation and would make a simulation affect the next real run.
      site = ctx.req.dryRun ? onboarded : ctx.store.upsertCareerSite(onboarded);
      ctx.log.info(`onboard:${site.id}`, `${site.name}: ats=${site.ats}, apply_mode=${site.profile.apply_mode ?? "?"}`, { ats: site.ats });
      if (plan.onboardOnly !== null) continue;
    }
    if (!plan.discover) continue;
    try {
      budget = await runSite(ctx, u, site, budget, plan.apply);
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.error("discover", `${site.name}: ${errMessage(e)}`, { site_id: site.id });
    }
    if (!ctx.req.dryRun) ctx.store.upsertCareerSite({ ...site, lastRunAt: ctx.now().toISOString() });
  }
}

async function runSite(ctx: RunContext, u: UserRun, site: CareerSite, budget: number, doApply: boolean): Promise<number> {
  const { user, profile, stats } = u;
  const career = ctx.deps.career!;
  const usesBrowser = site.ats === "custom" || site.profile.apply_mode === "agent";
  const session = usesBrowser ? await ctx.browser.open(user) : null;
  const discovered = await career.discover(session, site, site.profile.filters ?? []);
  stats.found(discovered.length);
  ctx.log.info("discover", `${site.name}: ${discovered.length} vacancies`, { site_id: site.id, found: discovered.length });

  const rawDedupDays = Number(ctx.store.getSetting("dedup_window_days"));
  const dedupSince = isoDaysAgo(ctx.now(), Number.isFinite(rawDedupDays) && rawDedupDays >= 0 ? rawDedupDays : 60);
  const candidates: { d: Discovered; vacancy: Vacancy }[] = [];
  for (const d of discovered) {
    const vacancy = ensureVacancy(ctx.store, skeletonVacancy(site.slug, d.externalId, d.url, d.title, d.company || site.name));
    const c = classify(ctx.store, user, profile, vacancy, dedupSince);
    if (c.kind === "sent") continue;
    if (c.kind === "skip") {
      if (c.status === Status.SKIP_DEDUP) stats.deduped();
      stats.record(c.status);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, c.status, c.detail));
      continue;
    }
    candidates.push({ d, vacancy });
  }
  if (budget <= 0) {
    ctx.log.info("discover", `${site.name}: ${candidates.length} candidates but daily limit reached`);
    return budget;
  }

  const fetched: Vacancy[] = [];
  for (const c of candidates.slice(0, budget * 2)) {
    ctx.checkAbort();
    try {
      const v = ctx.store.upsertVacancy({ ...(await career.fetch(session, site, c.d)), id: c.vacancy.id });
      if (v.hasTest) {
        stats.record(Status.SKIP_TEST_REQUIRED);
        ctx.store.insertApplication(newApp(ctx, user.id, v.id, Status.SKIP_TEST_REQUIRED, ""));
      } else fetched.push(v);
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("discover", `${c.d.title}: fetch failed: ${errMessage(e)}`);
    }
    if (session) await ctx.throttle.afterRead();
  }
  ctx.log.info("discover", `${site.name}: ${fetched.length} to tailor`, { to_tailor: fetched.length });
  if (!doApply || !fetched.length) return budget;

  const resume = ctx.deps.resume;
  if (!resume) {
    ctx.log.warn("tailor", "resume toolchain not available, cannot apply to career sites");
    return budget;
  }
  const basePath = pickBaseCV(ctx, user.slug, profile.directions);
  if (!basePath) {
    ctx.log.warn("tailor", `no base CV in ${paths.cvDir(ctx.cfg, user.slug)} (expected base-<direction>.yaml)`);
    return budget;
  }
  const base = await resume.loadCV(basePath);
  const tier = user.opusEnabled ? "tailor" : "write";

  for (const vacancy of fetched) {
    ctx.checkAbort();
    if (budget <= 0) {
      stats.record(Status.SKIP_LIMIT);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, Status.SKIP_LIMIT, "daily limit reached"));
      continue;
    }
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
        continue;
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
      continue;
    }

    const s = await ctx.browser.open(user);
    let questions: Question[] | undefined;
    let answers: Answer[] | undefined;
    try {
      const r = await career.apply(s, {
        site,
        vacancy,
        profile,
        resumePdfPath: pdfPath,
        coverLetter,
        dryRun: ctx.req.dryRun,
        answerQuestions: async (qs) => {
          questions = qs;
          answers = await ctx.llm.answerQuestionnaire(profile, vacancy, qs);
          stats.llmCall();
          return answers;
        },
      });
      const status = ctx.req.dryRun && r.status === Status.SENT ? Status.SKIP_DRY_RUN : r.status;
      const app = ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, status, r.reasonDetail), coverLetter, generatedResumeId: generatedId });
      const qs = r.questions ?? questions;
      const as = r.answers ?? answers;
      if (qs?.length && as?.length) ctx.store.insertQuestionnaireAnswers(app.id, qs, as);
      stats.record(status, vacancy);
      if (status === Status.SENT) budget--;
      if (r.learnedHints) {
        const updated = { ...site, profile: { ...site.profile, apply_hints: r.learnedHints } };
        site = ctx.req.dryRun ? updated : ctx.store.upsertCareerSite(updated);
      }
      ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status });
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      stats.record(Status.FAILED_UI, vacancy);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.FAILED_UI, errMessage(e)), coverLetter, generatedResumeId: generatedId });
      ctx.log.error("apply", `${vacancy.title}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
    }
    await ctx.throttle.afterMutation();
  }
  return budget;
}

function pickBaseCV(ctx: RunContext, slug: string, directions: string[]): string | null {
  const dir = paths.cvDir(ctx.cfg, slug);
  for (const d of [...directions, ""]) {
    const p = d ? `${dir}/base-${d}.yaml` : `${dir}/base.yaml`;
    if (ctx.fileExists(p)) return p;
  }
  return null;
}
