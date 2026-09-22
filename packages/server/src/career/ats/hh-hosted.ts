// Company pages on hh.ru (hh.ru/employer/<id>, company.hh.ru): nothing to do here — the hh pipeline
// (workstream C) covers them. Detected only by URL host so a "we're on hh.ru" link never misfires.
import { hostOf, pathSegments } from "../http.js";
import type { ATSClientImpl } from "./types.js";

export const hhHosted: ATSClientImpl = {
  kind: "hh_hosted",
  verified: true,
  notes: "handled by the hh pipeline; discover returns []",
  jobsUrl: () => "",
  detect(baseUrl) {
    const host = hostOf(baseUrl);
    if (!/(^|\.)hh\.ru$/.test(host)) return null;
    const segs = pathSegments(baseUrl);
    const id = segs[0] === "employer" ? segs[1] : undefined;
    return { token: id ?? host };
  },
  async listJobs() {
    return [];
  },
  async fetchJob() {
    throw new Error("hh_hosted sites are served by the hh pipeline");
  },
};
