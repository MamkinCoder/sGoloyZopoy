// Package model holds the shared domain types used by every other package.
// It has no dependencies on the rest of the project so any package may import it.
package model

import (
	"errors"
	"time"
)

// Source identifies where a vacancy came from: "hh" or a career-site adapter slug.
type Source string

const SourceHH Source = "hh"

// Status is the outcome of an application attempt. Codes borrowed from hh-outreach and extended.
type Status string

const (
	StatusSent Status = "SENT"

	SkipAlreadyApplied Status = "SKIP_ALREADY_APPLIED" // hh shows «Вы откликнулись»
	SkipTestRequired   Status = "SKIP_TEST_REQUIRED"   // vacancy requires a test; web-only, we don't do it
	SkipLLMReject      Status = "SKIP_LLM_REJECT"      // decide_hh said apply=false
	SkipDedup          Status = "SKIP_DEDUP"           // same company+title applied recently
	SkipLimit          Status = "SKIP_LIMIT"           // daily limit reached
	SkipDryRun         Status = "SKIP_DRY_RUN"
	SkipFilter         Status = "SKIP_FILTER"   // rule-based pre-filter: exclude_words, company blacklist, salary floor
	SkipArchived       Status = "SKIP_ARCHIVED" // vacancy archived between search and apply
	SkipForeign        Status = "SKIP_FOREIGN"  // other-country popup and allow_other_country=false

	FailedNoConfirmation Status = "FAILED_NO_CONFIRMATION"
	FailedUI             Status = "FAILED_UI"       // selector not found; snapshot saved
	FailedAntiBot        Status = "FAILED_ANTI_BOT" // "подозрительная активность" / 403 block
	FailedCaptcha        Status = "FAILED_CAPTCHA"  // explicit captcha page
	FailedLowMemory      Status = "FAILED_LOW_MEMORY"
	FailedLoginExpired   Status = "FAILED_LOGIN_EXPIRED"
	FailedLLM            Status = "FAILED_LLM"
	FailedLatex          Status = "FAILED_LATEX"

	NeedsHuman Status = "NEEDS_HUMAN" // chat thread the LLM refused to answer autonomously
)

// IsFatal reports whether a status must stop the whole run (not just skip the vacancy).
func (s Status) IsFatal() bool {
	return s == FailedAntiBot || s == FailedCaptcha || s == FailedLoginExpired || s == FailedLowMemory
}

// Sentinel errors that abort a whole run. The runner maps them to a fatal Status + Telegram alert.
var (
	ErrAntiBot      = errors.New("anti-bot block detected")
	ErrCaptcha      = errors.New("captcha required")
	ErrLoginExpired = errors.New("hh.ru session expired")
	ErrLowMemory    = errors.New("memory guard tripped")
)

type User struct {
	ID                int64
	Slug              string // "yaroslav", "alina"
	Name              string
	TGChatID          string // empty → use global chat
	DailyLimitHH      int
	DailyLimitCareer  int
	Active            bool
	AllowOtherCountry bool // click «Всё равно откликнуться» on the other-country popup
	PoolExpandPerDay  int  // max new hh resumes created per day by pool expand (default 2)
	OpusEnabled       bool // allow TierTailor (opus) for career-site CV tailoring
}

// Profile is the facts file the LLM is allowed to use. Stored as JSON in user_profiles.facts_json
// and mirrored in data/users/<slug>/profile.yaml.
type Profile struct {
	FullName    string   `json:"full_name" yaml:"full_name"`
	Email       string   `json:"email" yaml:"email"`
	Phone       string   `json:"phone" yaml:"phone"`
	Telegram    string   `json:"telegram" yaml:"telegram"`
	City        string   `json:"city" yaml:"city"`
	Citizenship string   `json:"citizenship" yaml:"citizenship"`
	Relocation  string   `json:"relocation" yaml:"relocation"`     // free text: "готов к переезду в любой регион и за границу"
	WorkFormats []string `json:"work_formats" yaml:"work_formats"` // remote / office / hybrid
	SalaryFrom  int      `json:"salary_from" yaml:"salary_from"`
	SalaryTo    int      `json:"salary_to" yaml:"salary_to"`
	Currency    string   `json:"currency" yaml:"currency"`
	Experience  string   `json:"experience" yaml:"experience"` // "2.5 года коммерческого опыта"
	Languages   []string `json:"languages" yaml:"languages"`
	Directions  []string `json:"directions" yaml:"directions"` // "go-backend", "node-backend", "react", "vue", "fullstack"

	VerifiedSkills   []string `json:"verified_skills" yaml:"verified_skills"`       // may be claimed
	NeverClaimSkills []string `json:"never_claim_skills" yaml:"never_claim_skills"` // must never be claimed
	Summary          string   `json:"summary" yaml:"summary"`                       // 3-5 lines about the person, dry

	HHQueries        []string          `json:"hh_queries" yaml:"hh_queries"`               // search strings for hh.ru
	HHArea           string            `json:"hh_area" yaml:"hh_area"`                     // hh area id; "" → no filter
	ExcludeWords     []string          `json:"exclude_words" yaml:"exclude_words"`         // title contains → SKIP_FILTER
	CompanyBlacklist []string          `json:"company_blacklist" yaml:"company_blacklist"` // company contains → SKIP_FILTER
	Extra            map[string]string `json:"extra" yaml:"extra"`                         // free facts for questionnaires: "готов к командировкам": "да"
}

type HHResume struct {
	ID          int64
	UserID      int64
	HHResumeID  string
	Title       string
	URL         string
	Direction   string
	Summary     ResumeSummary
	IsGenerated bool
	SyncedAt    time.Time
}

// ResumeSummary is produced by the summarize_resume prompt and used by decide_hh to pick a resume.
type ResumeSummary struct {
	Direction string   `json:"direction"`
	Seniority string   `json:"seniority"`
	KeySkills []string `json:"key_skills"`
	OneLine   string   `json:"one_line"`
}

type Vacancy struct {
	ID              int64
	Source          Source
	ExternalID      string
	URL             string
	Title           string
	Company         string
	SalaryFrom      int
	SalaryTo        int
	Currency        string
	DescriptionText string
	HasTest         bool
	RequiresLetter  bool
	Area            string
	WorkFormat      string
	PublishedAt     time.Time
	FirstSeenAt     time.Time
	DedupHash       string // NormalizeDedup(company, title)
}

type Application struct {
	ID                int64
	UserID            int64
	VacancyID         int64
	HHResumeID        *int64
	GeneratedResumeID *int64
	RunID             int64
	Attempt           int // 1..n; one row per attempt, partial unique index on SENT
	Status            Status
	ReasonDetail      string
	CoverLetter       string
	LLMDecision       *Decision
	CreatedAt         time.Time
}

// Decision is one element of the decide_hh prompt output.
type Decision struct {
	VacancyID   int64    `json:"vacancy_id"`
	Apply       bool     `json:"apply"`
	Reason      string   `json:"reason"`
	ResumeID    string   `json:"resume_id"` // HHResume.HHResumeID
	CoverLetter string   `json:"cover_letter"`
	Direction   string   `json:"direction"`
	Seniority   string   `json:"seniority"`
	RedFlags    []string `json:"red_flags"`
}

// Question is a single questionnaire field found after clicking «Откликнуться» (or in a career-site form).
type Question struct {
	Idx      int      `json:"idx"`
	Text     string   `json:"text"`
	Kind     string   `json:"kind"` // radio | checkbox | text | select | number
	Options  []string `json:"options,omitempty"`
	Required bool     `json:"required"`
}

// Answer is the LLM's answer to one Question.
type Answer struct {
	Idx        int    `json:"idx"`
	Text       string `json:"text,omitempty"`        // for text/number
	OptionIdx  *int   `json:"option_idx,omitempty"`  // for radio/select
	OptionIdxs []int  `json:"option_idxs,omitempty"` // for checkbox
}

type QuestionnaireAnswer struct {
	ID            int64
	ApplicationID int64
	Question      Question
	Answer        Answer
	CreatedAt     time.Time
}

type ChatThread struct {
	ID              int64
	UserID          int64
	HHNegotiationID string
	VacancyID       *int64
	Employer        string
	State           string // new | viewed | invited | rejected | archived
	LastSeenAt      time.Time
}

type ChatMessage struct {
	ID         int64
	ThreadID   int64
	Direction  string // in | out
	Author     string // employer | bot | me
	Text       string
	IsQuestion bool
	Answered   bool
	CreatedAt  time.Time
}

type GeneratedResume struct {
	ID        int64
	UserID    int64
	VacancyID int64
	TexPath   string
	PDFPath   string
	Model     string
	CreatedAt time.Time
}

type CareerSite struct {
	ID        int64
	UserID    int64
	Adapter   string
	BaseURL   string
	Config    map[string]any
	Enabled   bool
	LastRunAt *time.Time
}

type RunTrigger string

const (
	TriggerSchedule RunTrigger = "schedule"
	TriggerManual   RunTrigger = "manual"
	TriggerCLI      RunTrigger = "cli"
)

type RunStatus string

const (
	RunRunning RunStatus = "running"
	RunDone    RunStatus = "done"
	RunFailed  RunStatus = "failed"
	RunStopped RunStatus = "stopped" // fatal status hit (anti-bot / login expired)
)

type Run struct {
	ID         int64
	UserID     *int64
	Source     string // hh | career | all
	Trigger    RunTrigger
	StartedAt  time.Time
	FinishedAt *time.Time
	Status     RunStatus
	Stats      RunStats
	TGSent     bool
	Error      string
}

// RunStats is the JSON stored in runs.stats_json and rendered into the Telegram report.
type RunStats struct {
	Found        int            `json:"found"`
	Deduped      int            `json:"deduped"`
	ByStatus     map[Status]int `json:"by_status"`
	ChatReplies  int            `json:"chat_replies"`
	Invitations  int            `json:"invitations"`
	Rejections   int            `json:"rejections"`
	TopVacancies []TopVacancy   `json:"top_vacancies"`
	DryRun       bool           `json:"dry_run"`
}

type TopVacancy struct {
	Title      string `json:"title"`
	Company    string `json:"company"`
	SalaryFrom int    `json:"salary_from"`
	SalaryTo   int    `json:"salary_to"`
	URL        string `json:"url"`
}

type RunEvent struct {
	ID      int64          `json:"id"`
	RunID   int64          `json:"run_id"`
	TS      time.Time      `json:"ts"`
	Level   string         `json:"level"` // info | warn | error
	Stage   string         `json:"stage"` // search | fetch | decide | apply | chats | pool | report
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

// CV is the structured resume the LLM edits and the LaTeX renderer consumes.
// Stored as YAML in data/users/<slug>/cv/*.yaml.
type CV struct {
	Title     string         `json:"title" yaml:"title"` // \setYourJobTitle
	Name      string         `json:"name" yaml:"name"`
	Contacts  CVContacts     `json:"contacts" yaml:"contacts"`
	About     string         `json:"about" yaml:"about"`
	Skills    []CVSkillGroup `json:"skills" yaml:"skills"`
	Jobs      []CVJob        `json:"jobs" yaml:"jobs"`
	Education []CVEducation  `json:"education" yaml:"education"`
}

type CVContacts struct {
	Email    string `json:"email" yaml:"email"`
	Phone    string `json:"phone" yaml:"phone"`
	Telegram string `json:"telegram" yaml:"telegram"`
	GitHub   string `json:"github" yaml:"github"`
	City     string `json:"city" yaml:"city"`
}

type CVSkillGroup struct {
	Name  string   `json:"name" yaml:"name"`
	Items []string `json:"items" yaml:"items"`
}

type CVJob struct {
	Company  string   `json:"company" yaml:"company"`
	Role     string   `json:"role" yaml:"role"`
	Period   string   `json:"period" yaml:"period"`
	Location string   `json:"location" yaml:"location"`
	Summary  string   `json:"summary" yaml:"summary"`
	Bullets  []string `json:"bullets" yaml:"bullets"`
	Stack    []string `json:"stack" yaml:"stack"`
}

type CVEducation struct {
	Institution string `json:"institution" yaml:"institution"`
	Degree      string `json:"degree" yaml:"degree"`
	Period      string `json:"period" yaml:"period"`
	Note        string `json:"note" yaml:"note"`
}
