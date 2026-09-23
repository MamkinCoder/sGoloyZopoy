import type { ATSKind } from "@sgz/shared";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { hhHosted } from "./hh-hosted.js";
import { huntflow, potok } from "./html-listing.js";
import { lever } from "./lever.js";
import { smartrecruiters } from "./smartrecruiters.js";
import { teamtailor } from "./teamtailor.js";
import type { ATSClientImpl } from "./types.js";
import { avito } from "./avito.js";
import { siteClients } from "./sites/index.js";
import { tbank } from "./tbank.js";
import { vk } from "./vk.js";
import { wb } from "./wb.js";
import { workable } from "./workable.js";

// Order matters: specific hosted boards first, host-only hh last, generic HTML parsers in between.
export const atsClientImpls: ATSClientImpl[] = [greenhouse, lever, ashby, workable, smartrecruiters, teamtailor, wb, vk, avito, tbank, ...siteClients, huntflow, potok, hhHosted];

export const atsClientFor = (kind: ATSKind): ATSClientImpl | undefined => atsClientImpls.find((c) => c.kind === kind);

export type { ATSClientImpl } from "./types.js";
