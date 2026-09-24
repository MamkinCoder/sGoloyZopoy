import type {
  AgentJobDTO,
  AnalyticsDTO,
  ApplicationDetailDTO,
  ApplicationDTO,
  CareerSiteDTO,
  ChatMessageDTO,
  ChatThreadDTO,
  InterviewOutcome,
  DedupRowDTO,
  FilteredItemDTO,
  HealthDTO,
  Paged,
  ProfileDTO,
  QueueItemDTO,
  ResumesDTO,
  RunDTO,
  RunEventDTO,
  StartRunBody,
  StatsDTO,
  StudyDTO,
  UserDTO,
} from "@sgz/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isRunActive } from "../lib/status";
import { api, qs } from "./client";
import type { RetroDTO } from "@sgz/shared";

export type StatsRange = "today" | "7d" | "30d" | "all";
type SettingsMap = Record<string, unknown>;

export const keys = {
  me: ["me"] as const,
  users: ["users"] as const,
  profile: (slug: string) => ["profile", slug] as const,
  stats: (slug: string, range: StatsRange) => ["stats", slug, range] as const,
  analytics: (slug: string, range: StatsRange) => ["analytics", slug, range] as const,
  applications: (slug: string, params: ApplicationsParams) => ["applications", slug, params] as const,
  application: (id: number) => ["application", id] as const,
  resumes: (slug: string) => ["resumes", slug] as const,
  chats: (slug: string) => ["chats", slug] as const,
  chatMessages: (id: number) => ["chat-messages", id] as const,
  study: (slug: string, id: number) => ["study", slug, id] as const,
  runs: (slug: string, limit: number) => ["runs", slug, limit] as const,
  run: (id: number) => ["run", id] as const,
  runEvents: (id: number) => ["run-events", id] as const,
  dedup: (id: number) => ["dedup", id] as const,
  careerSites: (slug: string) => ["career-sites", slug] as const,
  adapters: ["adapters"] as const,
  health: ["health"] as const,
  settings: ["settings"] as const,
  queue: (slug: string) => ["queue", slug] as const,
  agentJobs: ["agent-jobs"] as const,
  filtered: (slug: string, source: string) => ["filtered", slug, source] as const,
};

// ---- auth
export const useMe = () =>
  useQuery({
    queryKey: keys.me,
    queryFn: () => api<{ authenticated: boolean; auth_required?: boolean }>("/me", { silent: true }),
    retry: false,
    staleTime: 60_000,
  });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api<{ ok: true }>("/login", { method: "POST", body: { password }, silent: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/logout", { method: "POST" }),
    onSuccess: () => qc.clear(),
  });
}

// ---- users & profile
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => api<UserDTO[]>("/users"), staleTime: 60_000 });

export function useUpdateUser(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserDTO>) => api<UserDTO>(`/users/${slug}`, { method: "PUT", body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.users }),
  });
}

export const useProfile = (slug: string) =>
  useQuery({ queryKey: keys.profile(slug), queryFn: () => api<ProfileDTO>(`/users/${slug}/profile`) });

export function useSaveProfile(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ProfileDTO) => api<ProfileDTO>(`/users/${slug}/profile`, { method: "PUT", body: p }),
    onSuccess: (data) => qc.setQueryData(keys.profile(slug), data),
  });
}

export const useStats = (slug: string, range: StatsRange) =>
  useQuery({
    queryKey: keys.stats(slug, range),
    queryFn: () => api<StatsDTO>(`/users/${slug}/stats${qs({ range })}`),
    refetchInterval: 30_000,
  });

export const useAnalytics = (slug: string, range: StatsRange) =>
  useQuery({
    queryKey: keys.analytics(slug, range),
    queryFn: () => api<AnalyticsDTO>(`/users/${slug}/analytics${qs({ range })}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

// ---- applications
interface ApplicationsParams {
  status?: string; // comma-separated
  source?: string;
  since?: string;
  until?: string;
  q?: string;
  page?: number;
  page_size?: number;
}

export const useApplications = (slug: string, params: ApplicationsParams) =>
  useQuery({
    queryKey: keys.applications(slug, params),
    queryFn: () => api<Paged<ApplicationDTO>>(`/users/${slug}/applications${qs({ ...params })}`),
    placeholderData: (prev) => prev,
  });

export const useApplication = (id: number | null) =>
  useQuery({
    queryKey: keys.application(id ?? 0),
    queryFn: () => api<ApplicationDetailDTO>(`/applications/${id}`),
    enabled: id != null,
  });

// ---- review queue + filtered-out vacancies
export const useQueue = (slug: string) =>
  useQuery({ queryKey: keys.queue(slug), queryFn: () => api<QueueItemDTO[]>(`/users/${slug}/queue`), refetchInterval: 60_000 });

export const useFiltered = (slug: string, source: string) =>
  useQuery({
    queryKey: keys.filtered(slug, source),
    queryFn: () => api<FilteredItemDTO[]>(`/users/${slug}/filtered${qs({ source })}`),
    placeholderData: (prev) => prev,
  });

/** send / inspect / force start a run (409 = runner busy); skip and cover-letter act immediately. */
export function useApplicationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: { id: number; action: "send" | "inspect" | "retailor" | "skip" | "mark-sent" | "force" | "cover-letter"; text?: string }) =>
      arg.action === "cover-letter"
        ? api<{ run_id?: number; ok?: boolean }>(`/applications/${arg.id}/cover-letter`, { method: "PUT", body: { text: arg.text } })
        : api<{ run_id?: number; ok?: boolean }>(`/applications/${arg.id}/${arg.action}`, { method: "POST", silent: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["filtered"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

// ---- resumes
export const useResumes = (slug: string) =>
  useQuery({ queryKey: keys.resumes(slug), queryFn: () => api<ResumesDTO>(`/users/${slug}/resumes`) });

export function useResumeAction(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: { action: "sync" | "touch" | "expand"; max?: number }) =>
      api<{ run_id: number }>(`/users/${slug}/resumes/${arg.action}`, {
        method: "POST",
        body: arg.action === "expand" ? { max: arg.max } : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: keys.health });
    },
  });
}

// ---- chats
export const useChats = (slug: string) =>
  useQuery({ queryKey: keys.chats(slug), queryFn: () => api<ChatThreadDTO[]>(`/users/${slug}/chats`), refetchInterval: 60_000 });

export function useSetInterview(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, at }: { id: number; at: string | null }) =>
      api<ChatThreadDTO>(`/users/${slug}/chats/${id}/interview`, { method: "PUT", body: { interview_at: at } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chats(slug) }),
  });
}

export function useSetOutcome(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: number; outcome: InterviewOutcome | null }) =>
      api<ChatThreadDTO>(`/users/${slug}/chats/${id}/outcome`, { method: "PUT", body: { outcome } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chats(slug) }),
  });
}

/** Interview study pack; polled every 3 s while the server is building it. */
export const useStudy = (slug: string, id: number) =>
  useQuery({
    queryKey: keys.study(slug, id),
    queryFn: () => api<StudyDTO>(`/users/${slug}/chats/${id}/study`),
    refetchInterval: (q) => (q.state.data?.generating ? 3000 : false),
  });

export function useStartStudy(slug: string, id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ generating: boolean }>(`/users/${slug}/chats/${id}/study`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.study(slug, id) }),
  });
}

export const useChatMessages = (id: number | null) =>
  useQuery({
    queryKey: keys.chatMessages(id ?? 0),
    queryFn: () => api<ChatMessageDTO[]>(`/chats/${id}/messages`),
    enabled: id != null,
  });

// ---- runs
export const useRuns = (slug: string, limit: number) =>
  useQuery({
    queryKey: keys.runs(slug, limit),
    queryFn: () => api<RunDTO[]>(`/runs${qs({ user: slug, limit })}`),
    refetchInterval: 15_000,
  });

export const useRun = (id: number) =>
  useQuery({
    queryKey: keys.run(id),
    queryFn: () => api<RunDTO>(`/runs/${id}`),
    refetchInterval: (q) => (isRunActive(q.state.data?.status) ? 5_000 : false),
  });

export const useRunEvents = (id: number, enabled = true) =>
  useQuery({
    queryKey: keys.runEvents(id),
    queryFn: () => api<RunEventDTO[]>(`/runs/${id}/events?after=0`),
    enabled,
    staleTime: Infinity,
  });

export const useDedup = (id: number, enabled = true) =>
  useQuery({ queryKey: keys.dedup(id), queryFn: () => api<DedupRowDTO[]>(`/runs/${id}/dedup`), enabled });

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartRunBody) => api<{ run_id: number }>("/runs", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: keys.health });
    },
  });
}

export function useStopRun(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/runs/${id}/stop`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.run(id) });
    },
  });
}

// ---- career sites
export const useCareerSites = (slug: string) =>
  useQuery({ queryKey: keys.careerSites(slug), queryFn: () => api<CareerSiteDTO[]>(`/users/${slug}/career-sites`) });

export const useAdapters = () =>
  useQuery({ queryKey: keys.adapters, queryFn: () => api<string[]>("/adapters"), staleTime: Infinity });

export type CareerSiteBody = Pick<CareerSiteDTO, "name" | "baseUrl" | "ats" | "profile" | "enabled">;

export function useCareerSiteMutations(slug: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.careerSites(slug) });
  const create = useMutation({
    mutationFn: (body: CareerSiteBody) => api<CareerSiteDTO>(`/users/${slug}/career-sites`, { method: "POST", body }),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<CareerSiteBody> }) =>
      api<CareerSiteDTO>(`/career-sites/${id}`, { method: "PUT", body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean }>(`/career-sites/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  // Queue a `career` run that onboards one configured site.
  const runStarted = () => {
    qc.invalidateQueries({ queryKey: ["runs"] });
  };
  const onboard = useMutation({
    mutationFn: (id: number) => api<{ run_id: number }>(`/users/${slug}/career-sites/${id}/onboard`, { method: "POST" }),
    onSuccess: runStarted,
  });
  // Queue a `career` run over this one site: gather → decide → tailored CV → review queue.
  const run = useMutation({
    mutationFn: (id: number) => api<{ run_id: number }>(`/users/${slug}/career-sites/${id}/run`, { method: "POST" }),
    onSuccess: runStarted,
  });
  return { create, update, remove, onboard, run };
}

// ---- system
/** The always-on agent's queue (newest first). */
export const useAgentJobs = () => useQuery({ queryKey: keys.agentJobs, queryFn: () => api<AgentJobDTO[]>("/agent/jobs", { silent: true }), refetchInterval: 15_000 });

export const useHealth = () =>
  useQuery({ queryKey: keys.health, queryFn: () => api<HealthDTO>("/health", { silent: true }), refetchInterval: 10_000, retry: false });

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api<SettingsMap>("/settings") });

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsMap) => api<SettingsMap>("/settings", { method: "PUT", body: patch }),
    onSuccess: (data) => qc.setQueryData(keys.settings, data),
  });
}

// ---- letter lessons (outcome learning loop)
export type LetterLessons = { lessons: string[]; at: string };
export const useLessons = (slug: string) =>
  useQuery({ queryKey: ["lessons", slug] as const, queryFn: () => api<LetterLessons>(`/users/${slug}/lessons`) });

export function useResetLessons(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<LetterLessons>(`/users/${slug}/lessons`, { method: "DELETE" }),
    onSuccess: (data) => qc.setQueryData(["lessons", slug], data),
  });
}
/** Weekly retro (null = fewer than 10 sends this week). */
export const useRetro = (slug: string) =>
  useQuery({ queryKey: ["retro", slug], queryFn: () => api<RetroDTO | null>(`/users/${slug}/retro`), refetchInterval: 300_000 });
