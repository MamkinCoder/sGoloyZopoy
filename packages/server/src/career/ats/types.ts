import type { ATSClient, ATSKind } from "@sgz/shared";

/** ATSClient plus what the agent needs to write a SiteProfile without asking the LLM. */
export interface ATSClientImpl extends ATSClient {
  /** Public JSON/RSS endpoint we read jobs from (stored into SiteProfile.jobs_json_url). */
  jobsUrl(token: string): string;
  /** Endpoint knowledge confirmed against live docs/API at implementation time. */
  verified: boolean;
  /** Free-text caveats surfaced in reports / SiteProfile.notes. */
  notes: string;
  /** A job board listing many employers (Habr Career): keep each vacancy's own company instead of the site name. */
  aggregator?: boolean;
}

export const atsId = (kind: ATSKind, id: string | number): string => `${kind}:${id}`;

/** "greenhouse:123" / "site:mts:123" → "123"; anything else unchanged. */
export const rawId = (externalId: string): string => externalId.replace(/^(?:site:[a-z0-9-]+|[a-z_]+):/, "");

export const slugRe = "[a-z0-9][a-z0-9_.-]*";

/** First capture group of the first matching regex, or null. */
export function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}
