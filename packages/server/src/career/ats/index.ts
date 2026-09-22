import type { ATSClient, ATSKind } from "@sgz/shared";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { hhHosted } from "./hh-hosted.js";
import { huntflow, potok } from "./html-listing.js";
import { lever } from "./lever.js";
import { smartrecruiters } from "./smartrecruiters.js";
import { teamtailor } from "./teamtailor.js";
import type { ATSClientImpl } from "./types.js";
import { workable } from "./workable.js";

// Order matters: specific hosted boards first, host-only hh last, generic HTML parsers in between.
export const atsClientImpls: ATSClientImpl[] = [greenhouse, lever, ashby, workable, smartrecruiters, teamtailor, huntflow, potok, hhHosted];

export const atsClients: ATSClient[] = atsClientImpls;

export function detectATS(baseUrl: string, html: string): { kind: ATSKind; token: string } | null {
  for (const c of atsClientImpls) {
    const hit = c.detect(baseUrl, html);
    if (hit) return { kind: c.kind, token: hit.token };
  }
  return null;
}

export const atsClientFor = (kind: ATSKind): ATSClientImpl | undefined => atsClientImpls.find((c) => c.kind === kind);

/** Which endpoints were confirmed live — for reports and SiteProfile.notes. */
export const ATS_ENDPOINT_STATUS: Record<string, { verified: boolean; notes: string }> = Object.fromEntries(
  atsClientImpls.map((c) => [c.kind, { verified: c.verified, notes: c.notes }]),
);

export type { ATSClientImpl } from "./types.js";
