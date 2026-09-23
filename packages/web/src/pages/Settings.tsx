import type { ATSKind, CareerSiteDTO, ProfileDTO, UserDTO } from "@sgz/shared";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  useAdapters,
  useCareerSiteMutations,
  useCareerSites,
  useLessons,
  useProfile,
  useResetLessons,
  useSaveProfile,
  useSaveSettings,
  useSettings,
  useUpdateUser,
  useUsers,
  type CareerSiteBody,
} from "../api/hooks";
import { ChipInput } from "../components/ChipInput";
import { Dialog } from "../components/Dialog";
import { JsonView } from "../components/JsonView";
import { Field, Section, Spinner, Toggle } from "../components/Ui";
import { fmtDateTime } from "../lib/format";
import { toast } from "../lib/toast";

const TABS = [
  { key: "profile", label: "Профиль" },
  { key: "user", label: "Пользователь" },
  { key: "sites", label: "Карьерные сайты" },
  { key: "schedule", label: "Расписание" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function SettingsPage() {
  const { slug = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) || "profile";
  return (
    <div className="grid gap-3">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`tab ${tab === t.key ? "tab-active" : ""}`} onClick={() => setSp({ tab: t.key }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "profile" && <ProfileEditor slug={slug} />}
      {tab === "profile" && <LetterLessonsBox slug={slug} />}
      {tab === "user" && <UserEditor slug={slug} />}
      {tab === "sites" && <CareerSites slug={slug} />}
      {tab === "schedule" && <ScheduleEditor />}
    </div>
  );
}

// ---------- Profile

function ProfileEditor({ slug }: { slug: string }) {
  const q = useProfile(slug);
  const save = useSaveProfile(slug);
  const [p, setP] = useState<ProfileDTO | null>(null);
  // Extra facts are edited as rows so an empty/duplicate key doesn't drop the row; p.extra gets only named rows.
  const [extraRows, setExtraRows] = useState<[string, string][]>([]);
  const reset = (d: ProfileDTO) => {
    setP(d);
    setExtraRows(Object.entries(d.extra));
  };
  useEffect(() => {
    if (q.data) reset(q.data);
  }, [q.data]);
  if (!p) return <Spinner />;

  const set = <K extends keyof ProfileDTO>(k: K, v: ProfileDTO[K]) => setP({ ...p, [k]: v });
  const text = (k: keyof ProfileDTO, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" value={String(p[k] ?? "")} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );
  const num = (k: "salary_from" | "salary_to", label: string) => (
    <Field label={label}>
      <input className="input" type="number" value={p[k]} onChange={(e) => set(k, Number(e.target.value) || 0)} />
    </Field>
  );
  const chips = (k: keyof ProfileDTO, label: string, hint?: string, variant?: "danger") => (
    <Field label={label} hint={hint}>
      <ChipInput value={p[k] as string[]} onChange={(v) => set(k, v as never)} variant={variant} />
    </Field>
  );
  const setExtra = (rows: [string, string][]) => {
    setExtraRows(rows);
    set("extra", Object.fromEntries(rows.filter(([k]) => k.trim())));
  };

  const dirty = JSON.stringify(p) !== JSON.stringify(q.data);

  return (
    <div className="grid gap-4">
      <Section title="Контакты">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {text("full_name", "Полное имя")}
          {text("email", "Email")}
          {text("phone", "Телефон")}
          {text("telegram", "Telegram")}
          {text("city", "Город")}
          {text("citizenship", "Гражданство")}
        </div>
      </Section>
      <Section title="Условия">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {text("relocation", "Релокация", "свободный текст")}
          {chips("work_formats", "Форматы работы", "remote / office / hybrid")}
          {text("experience", "Опыт", "напр. «2.5 года»")}
          {num("salary_from", "Зарплата от")}
          {num("salary_to", "Зарплата до")}
          {text("currency", "Валюта")}
          {chips("languages", "Языки")}
        </div>
        {p.salary_from === 0 && <div className="faint text-[12px] mt-2">0 в «от» — агент никогда не называет цифру.</div>}
      </Section>
      <Section title="Профессиональное">
        <div className="grid gap-3">
          {chips("directions", "Направления", "go-backend, node-backend, react, vue, fullstack, android…")}
          <Field label="Summary">
            <textarea className="input" rows={4} value={p.summary} onChange={(e) => set("summary", e.target.value)} />
          </Field>
          {chips("verified_skills", "Подтверждённые навыки", "только то, что реально умеет")}
          {chips("never_claim_skills", "Никогда не заявлять", "LLM не имеет права приписывать эти навыки", "danger")}
        </div>
      </Section>
      <Section title="Поиск на hh">
        <div className="grid gap-3">
          {chips("hh_queries", "Поисковые запросы")}
          <div className="grid gap-3 sm:grid-cols-2">{text("hh_area", "Регион hh (area id)", "пусто — без фильтра")}</div>
          {chips("exclude_words", "Стоп-слова в заголовке")}
          {chips("company_blacklist", "Чёрный список компаний")}
          {chips("known_companies", "Знакомые в компаниях", "«Компания - Имя»: карточки этой компании напомнят попросить рекомендацию. В LLM не передаётся")}
        </div>
      </Section>
      <Section
        title="Доп. факты для анкет"
        right={
          <button type="button" className="btn btn-sm" onClick={() => setExtra([...extraRows, ["", ""]])}>
            + строка
          </button>
        }
      >
        {extraRows.length === 0 && <div className="faint text-[12px]">Пусто — ключ/значение, например «готов к командировкам: да»</div>}
        <div className="grid gap-2">
          {extraRows.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <input
                className="input"
                placeholder="ключ"
                value={k}
                onChange={(e) => {
                  const rows = [...extraRows] as [string, string][];
                  rows[i] = [e.target.value, v];
                  setExtra(rows);
                }}
              />
              <input
                className="input"
                placeholder="значение"
                value={v}
                onChange={(e) => {
                  const rows = [...extraRows] as [string, string][];
                  rows[i] = [k, e.target.value];
                  setExtra(rows);
                }}
              />
              <button type="button" className="btn" onClick={() => setExtra(extraRows.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>
      </Section>
      <SaveBar dirty={dirty} pending={save.isPending} onReset={() => q.data && reset(q.data)} onSave={() => save.mutate(p, { onSuccess: () => toast.ok("Профиль сохранён") })} />
    </div>
  );
}

// Read-only: rebuilt weekly from invited vs. not invited letters, fed into every cover-letter prompt.
function LetterLessonsBox({ slug }: { slug: string }) {
  const q = useLessons(slug);
  const reset = useResetLessons(slug);
  const lessons = q.data?.lessons ?? [];
  return (
    <Section
      title="Уроки писем"
      right={
        <button type="button" className="btn btn-sm" disabled={!lessons.length || reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => toast.ok("Уроки сброшены") })}>
          Сбросить
        </button>
      }
    >
      {lessons.length ? (
        <textarea className="input" rows={Math.min(lessons.length + 1, 9)} readOnly value={lessons.map((l) => `- ${l}`).join("\n")} />
      ) : (
        <div className="faint text-[12px]">Пока нет: нужны хотя бы 5 писем с приглашением и 15 без него. Обновляются раз в неделю.</div>
      )}
      {q.data?.at && <div className="faint text-[12px] mt-2">Обновлено {fmtDateTime(q.data.at)}</div>}
    </Section>
  );
}

function SaveBar({ dirty, pending, onSave, onReset }: { dirty: boolean; pending: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div className="sticky bottom-0 py-2 flex justify-end gap-2 bg-[var(--bg)]/90 backdrop-blur">
      <button type="button" className="btn" disabled={!dirty || pending} onClick={onReset}>
        Отменить
      </button>
      <button type="button" className="btn btn-primary" disabled={!dirty || pending} onClick={onSave}>
        {pending ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  );
}

// ---------- User

function UserEditor({ slug }: { slug: string }) {
  const users = useUsers();
  const update = useUpdateUser(slug);
  const src = users.data?.find((u) => u.slug === slug);
  const [u, setU] = useState<UserDTO | null>(null);
  useEffect(() => {
    if (src) setU(src);
  }, [src]);
  if (!u) return <Spinner />;
  const set = <K extends keyof UserDTO>(k: K, v: UserDTO[K]) => setU({ ...u, [k]: v });
  const dirty = JSON.stringify(u) !== JSON.stringify(src);
  return (
    <div className="grid gap-4">
      <Section title={`Пользователь ${u.slug}`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Имя">
            <input className="input" value={u.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Telegram chat id" hint="пусто — общий чат">
            <input className="input" value={u.tgChatId} onChange={(e) => set("tgChatId", e.target.value)} />
          </Field>
          <Field label="Лимит откликов/день, hh">
            <input className="input" type="number" min={0} value={u.dailyLimitHH} onChange={(e) => set("dailyLimitHH", Number(e.target.value) || 0)} />
          </Field>
          <Field label="Лимит откликов/день, сайты">
            <input className="input" type="number" min={0} value={u.dailyLimitCareer} onChange={(e) => set("dailyLimitCareer", Number(e.target.value) || 0)} />
          </Field>
          <Field label="Расширение пула, резюме/день">
            <input className="input" type="number" min={0} value={u.poolExpandPerDay} onChange={(e) => set("poolExpandPerDay", Number(e.target.value) || 0)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 mt-3">
          <Toggle checked={u.active} onChange={(v) => set("active", v)} label="Активен (участвует в расписании)" />
          <Toggle checked={u.allowOtherCountry} onChange={(v) => set("allowOtherCountry", v)} label="Откликаться на вакансии в других странах" />
          <Toggle checked={u.opusEnabled} onChange={(v) => set("opusEnabled", v)} label="Использовать Opus для решений" />
        </div>
      </Section>
      <SaveBar dirty={dirty} pending={update.isPending} onReset={() => src && setU(src)} onSave={() => update.mutate(u, { onSuccess: () => toast.ok("Сохранено") })} />
    </div>
  );
}

// ---------- Career sites

const ATS: ATSKind[] = ["greenhouse", "lever", "ashby", "workable", "teamtailor", "smartrecruiters", "huntflow", "potok", "wb", "vk", "avito", "tbank", "hh_hosted", "custom"];
const emptySite = (): CareerSiteBody => ({ name: "", baseUrl: "", ats: "custom", profile: {}, enabled: true });

function CareerSites({ slug }: { slug: string }) {
  const sites = useCareerSites(slug);
  const adapters = useAdapters();
  const m = useCareerSiteMutations(slug);
  const [editing, setEditing] = useState<{ id: number | null; body: CareerSiteBody } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const atsOptions = adapters.data?.length ? adapters.data : ATS;

  const submit = () => {
    if (!editing) return;
    const done = () => {
      toast.ok("Сохранено");
      setEditing(null);
    };
    if (editing.id == null) m.create.mutate(editing.body, { onSuccess: done });
    else m.update.mutate({ id: editing.id, body: editing.body }, { onSuccess: done });
  };

  return (
    <div className="grid gap-3">
      <Section
        title="Карьерные сайты"
        right={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ id: null, body: emptySite() })}>
            + Добавить
          </button>
        }
      >
        {sites.isLoading && <Spinner />}
        {sites.data?.length === 0 && <div className="faint text-center py-4">Сайтов нет</div>}
        <div className="grid gap-2">
          {sites.data?.map((s) => (
            <SiteRow
              key={s.id}
              site={s}
              open={open === s.id}
              busy={m.run.isPending || m.onboard.isPending}
              onToggle={() => setOpen((o) => (o === s.id ? null : s.id))}
              onEdit={() => setEditing({ id: s.id, body: { name: s.name, baseUrl: s.baseUrl, ats: s.ats, profile: s.profile, enabled: s.enabled } })}
              onDelete={() => window.confirm(`Удалить «${s.name}»?`) && m.remove.mutate(s.id, { onSuccess: () => toast.ok("Удалено") })}
              onOnboard={() => m.onboard.mutate(s.id, { onSuccess: ({ run_id }) => toast.ok(`Онбординг запущен: run #${run_id}`) })}
              onRun={() => m.run.mutate(s.id, { onSuccess: ({ run_id }) => toast.ok(`Сайт запущен: run #${run_id}, вакансии появятся в «Очереди»`) })}
              onSaveProfile={(profile) => m.update.mutate({ id: s.id, body: { profile } }, { onSuccess: () => toast.ok("Подсказки сохранены") })}
              onToggleEnabled={(enabled) => m.update.mutate({ id: s.id, body: { enabled } })}
            />
          ))}
        </div>
      </Section>

      <Dialog
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing?.id == null ? "Новый сайт" : "Сайт"}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary" disabled={!editing?.body.name || !editing?.body.baseUrl} onClick={submit}>
              Сохранить
            </button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-3">
            <Field label="Название">
              <input className="input" value={editing.body.name} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, name: e.target.value } })} />
            </Field>
            <Field label="Базовый URL">
              <input className="input" placeholder="https://company.com/careers" value={editing.body.baseUrl} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, baseUrl: e.target.value } })} />
            </Field>
            <Field label="ATS / адаптер" hint="custom — агент Stagehand; остальное — API ATS">
              <select className="input" value={editing.body.ats} onChange={(e) => setEditing({ ...editing, body: { ...editing.body, ats: e.target.value as ATSKind } })}>
                {atsOptions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
            <Toggle checked={editing.body.enabled} onChange={(v) => setEditing({ ...editing, body: { ...editing.body, enabled: v } })} label="Включён" />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function SiteRow({
  site,
  open,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onOnboard,
  onRun,
  onSaveProfile,
  onToggleEnabled,
}: {
  site: CareerSiteDTO;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOnboard: () => void;
  onRun: () => void;
  onSaveProfile: (p: CareerSiteDTO["profile"]) => void;
  onToggleEnabled: (v: boolean) => void;
}) {
  const [hints, setHints] = useState(site.profile);
  useEffect(() => setHints(site.profile), [site.profile]);
  const dirty = JSON.stringify(hints) !== JSON.stringify(site.profile);
  const setH = <K extends keyof CareerSiteDTO["profile"]>(k: K, v: CareerSiteDTO["profile"][K]) => setHints({ ...hints, [k]: v });

  return (
    <div className={`card ${site.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" className="faint" onClick={onToggle} aria-label="Развернуть">
          {open ? "▾" : "▸"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[13px]">
            {site.name} <span className="chip ml-1">{site.ats}</span>
            {site.profile.apply_mode && <span className="faint text-[11px] ml-1">{site.profile.apply_mode}</span>}
          </div>
          <a href={site.baseUrl} target="_blank" rel="noreferrer" className="text-[12px] truncate block">
            {site.baseUrl}
          </a>
        </div>
        <span className="faint text-[11px] hidden sm:inline">
          {site.lastRunAt ? `обход ${fmtDateTime(site.lastRunAt)}` : "не обходился"}
          {site.profile.last_verified_at && ` · проверен ${fmtDateTime(site.profile.last_verified_at)}`}
          {site.yield && (
            <span title="за 30 дней: вакансий дошло до фильтров / попало в очередь или отправлено">
              {" "}
              · 30д {site.yield.found}/{site.yield.queued}
            </span>
          )}
          {!!site.fails && (
            <span className="text-[var(--bad)]" title="неудачных обходов подряд; с 5 сайт обходится раз в неделю">
              {" "}
              · ошибок {site.fails}
            </span>
          )}
        </span>
        <Toggle checked={site.enabled} onChange={onToggleEnabled} label="вкл" />
        <button type="button" className="btn btn-sm" onClick={onRun} disabled={!site.enabled || busy}>
          Запустить
        </button>
        <button type="button" className="btn btn-sm" onClick={onOnboard} disabled={busy}>
          Онбординг
        </button>
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Изменить
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
          ×
        </button>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] p-3 grid gap-3 lg:grid-cols-2">
          <div>
            <div className="section-title">Профиль сайта (что узнал агент)</div>
            <div className="card p-2 max-h-72 overflow-auto text-[12px]">
              <JsonView value={site.profile} open={2} />
            </div>
          </div>
          <div className="grid gap-2 content-start">
            <div className="section-title">Подсказки агенту (редактируемые)</div>
            <Field label="Фильтры (ключевые слова вакансий)">
              <ChipInput value={hints.filters ?? []} onChange={(v) => setH("filters", v)} />
            </Field>
            <Field label="discover_hints">
              <textarea className="input" rows={2} value={hints.discover_hints ?? ""} onChange={(e) => setH("discover_hints", e.target.value)} />
            </Field>
            <Field label="apply_hints">
              <textarea className="input" rows={3} value={hints.apply_hints ?? ""} onChange={(e) => setH("apply_hints", e.target.value)} />
            </Field>
            <Field label="notes">
              <textarea className="input" rows={2} value={hints.notes ?? ""} onChange={(e) => setH("notes", e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-sm" disabled={!dirty} onClick={() => setHints(site.profile)}>
                Отменить
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => onSaveProfile(hints)}>
                Сохранить подсказки
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Schedule / global settings

const KNOWN: { key: string; label: string; kind: "text" | "number"; hint?: string }[] = [
  { key: "schedule_at", label: "Время запуска", kind: "text", hint: "HH:MM; пусто — расписание выключено" },
  { key: "schedule_jitter_min", label: "Случайная задержка, мин", kind: "number", hint: "0 и больше" },
  { key: "dedup_window_days", label: "Окно дедупликации, дней", kind: "number", hint: "0 и больше" },
  { key: "tz", label: "Часовой пояс", kind: "text", hint: "например Europe/Moscow" },
  { key: "digest_at", label: "Итоги дня в Telegram", kind: "text", hint: "HH:MM; пусто — выключено" },
  { key: "queue_tg_cards", label: "Карточки очереди в Telegram", kind: "text", hint: "1 — кнопки «Отправить / Пропустить», 0 — выкл" },
  { key: "viewers_enabled", label: "Отклик тем, кто смотрел резюме", kind: "text", hint: "1 — откликаться на вакансии работодателей, открывших резюме (до 3 за запуск), 0 — выкл" },
];

function ScheduleEditor() {
  const q = useSettings();
  const save = useSaveSettings();
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  if (!s) return <Spinner />;
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const knownKeys = new Set(KNOWN.map((k) => k.key));
  const other = Object.keys(s).filter((k) => !knownKeys.has(k));
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data);

  return (
    <div className="grid gap-4">
      <Section title="Расписание и система">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {KNOWN.map((k) =>
            <Field key={k.key} label={k.label} hint={k.hint}>
              <input
                className="input"
                type={k.kind === "number" ? "number" : "text"}
                min={k.kind === "number" ? 0 : undefined}
                value={s[k.key] == null ? "" : String(s[k.key])}
                onChange={(e) => set(k.key, k.kind === "number" ? Number(e.target.value) : e.target.value)}
              />
            </Field>,
          )}
        </div>
      </Section>
      <Section title="Остальные ключи" right={<span className="faint text-[12px]">как есть, строки</span>}>
        {other.length === 0 && <div className="faint text-[12px]">нет</div>}
        <div className="grid gap-2">
          {other.map((k) => (
            <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 items-center">
              <span className="kbd text-[12px] truncate">{k}</span>
              <input
                className="input"
                value={typeof s[k] === "string" ? (s[k] as string) : JSON.stringify(s[k])}
                onChange={(e) => set(k, e.target.value)}
              />
            </div>
          ))}
        </div>
      </Section>
      <SaveBar dirty={dirty} pending={save.isPending} onReset={() => q.data && setS(q.data)} onSave={() => save.mutate(s, { onSuccess: () => toast.ok("Настройки сохранены") })} />
    </div>
  );
}
