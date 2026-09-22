import type { SearchParams } from "@sgz/shared";

export const HH_ORIGIN = "https://hh.ru";
export const HH_CHAT_ORIGIN = "https://chatik.hh.ru";

export const searchUrl = (p: SearchParams): string => {
  const q = new URLSearchParams();
  q.set("text", p.query);
  q.set("order_by", "publication_time");
  q.set("search_period", String(p.period ?? 1));
  q.set("items_on_page", String(p.itemsOnPage ?? 50));
  q.set("page", String(p.page ?? 0));
  if (p.area) q.set("area", p.area);
  return `${HH_ORIGIN}/search/vacancy?${q.toString()}`;
};

export const vacancyUrl = (idOrUrl: string): string => {
  const id = vacancyIdFrom(idOrUrl);
  return id ? `${HH_ORIGIN}/vacancy/${id}` : idOrUrl;
};

/** "12345", "https://hh.ru/vacancy/12345?from=…", "https://spb.hh.ru/vacancy/12345" → "12345". */
export const vacancyIdFrom = (idOrUrl: string): string | null => {
  const s = idOrUrl.trim();
  if (/^\d+$/.test(s)) return s;
  const m = /\/vacancy\/(\d+)/.exec(s);
  return m?.[1] ?? null;
};

export const negotiationsUrl = (opts?: { onlyUnread?: boolean }): string =>
  `${HH_ORIGIN}/applicant/negotiations${opts?.onlyUnread ? "?filter=unread" : ""}`;

export const resumesUrl = (): string => `${HH_ORIGIN}/applicant/resumes`;
export const loginUrl = (): string => `${HH_ORIGIN}/account/login?role=applicant`;
export const resumeUrl = (hash: string): string => `${HH_ORIGIN}/resume/${hash}`;
export const chatUrl = (chatId: string): string => `${HH_CHAT_ORIGIN}/chat/${chatId}`;

export const resumeHashFrom = (url: string): string | null => {
  const m = /\/resume\/([0-9a-f]{20,40})/i.exec(url);
  return m?.[1] ?? null;
};

export const isLoginUrl = (url: string): boolean => /\/account\/login|\/login(\?|$)/.test(url);
export const isCaptchaUrl = (url: string): boolean => /captcha/i.test(url);
