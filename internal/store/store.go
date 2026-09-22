// Package store is the SQLite persistence layer (modernc.org/sqlite, no cgo).
// Contract file: workstream A implements Store; everything else calls these methods.
package store

import (
	"context"
	"time"

	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// ApplicationFilter narrows ListApplications.
type ApplicationFilter struct {
	UserID   int64
	Status   []model.Status
	Source   model.Source
	Since    time.Time
	Until    time.Time
	Page     int
	PageSize int
}

// ApplicationRow joins an application with its vacancy for listing.
type ApplicationRow struct {
	Application model.Application
	Vacancy     model.Vacancy
	ResumeTitle string
}

// Stats is the dashboard aggregate for one user and range.
type Stats struct {
	Sent        int
	Skipped     int
	Failed      int
	ByStatus    map[model.Status]int
	Invitations int
	Rejections  int
	ChatReplies int
	RunsCount   int
}

type Store interface {
	Migrate(ctx context.Context) error
	Close() error

	// users
	UpsertUser(ctx context.Context, u *model.User) error
	GetUserBySlug(ctx context.Context, slug string) (*model.User, error)
	ListUsers(ctx context.Context, onlyActive bool) ([]model.User, error)
	GetProfile(ctx context.Context, userID int64) (*model.Profile, error)
	SaveProfile(ctx context.Context, userID int64, p *model.Profile) error

	// hh resumes
	UpsertHHResume(ctx context.Context, r *model.HHResume) error
	ListHHResumes(ctx context.Context, userID int64) ([]model.HHResume, error)
	GetHHResumeByHHID(ctx context.Context, hhResumeID string) (*model.HHResume, error)

	// vacancies
	UpsertVacancy(ctx context.Context, v *model.Vacancy) error // sets v.ID; keeps first_seen_at
	GetVacancy(ctx context.Context, id int64) (*model.Vacancy, error)
	FindVacancyByExternal(ctx context.Context, source model.Source, externalID string) (*model.Vacancy, error)
	// HasRecentApplicationByDedup returns true if user applied to a vacancy with this dedup_hash since `since`.
	HasRecentApplicationByDedup(ctx context.Context, userID int64, dedupHash string, since time.Time) (bool, error)

	// applications
	HasApplication(ctx context.Context, userID, vacancyID int64) (bool, error)
	InsertApplication(ctx context.Context, a *model.Application) error
	UpdateApplicationStatus(ctx context.Context, id int64, status model.Status, detail string) error
	ListApplications(ctx context.Context, f ApplicationFilter) ([]ApplicationRow, int, error)
	CountSentToday(ctx context.Context, userID int64, source model.Source, day time.Time) (int, error)
	InsertQuestionnaireAnswers(ctx context.Context, applicationID int64, qs []model.Question, as []model.Answer) error
	ListQuestionnaireAnswers(ctx context.Context, applicationID int64) ([]model.QuestionnaireAnswer, error)

	// chats
	UpsertChatThread(ctx context.Context, t *model.ChatThread) error
	ListChatThreads(ctx context.Context, userID int64) ([]model.ChatThread, error)
	InsertChatMessages(ctx context.Context, threadID int64, msgs []model.ChatMessage) (inserted int, err error) // dedup by (thread, text, direction)
	ListChatMessages(ctx context.Context, threadID int64) ([]model.ChatMessage, error)
	MarkAnswered(ctx context.Context, messageIDs []int64) error

	// generated resumes
	InsertGeneratedResume(ctx context.Context, g *model.GeneratedResume) error
	ListGeneratedResumes(ctx context.Context, userID int64) ([]model.GeneratedResume, error)
	GetGeneratedResume(ctx context.Context, id int64) (*model.GeneratedResume, error)

	// career sites
	ListCareerSites(ctx context.Context, userID int64, onlyEnabled bool) ([]model.CareerSite, error)
	UpsertCareerSite(ctx context.Context, c *model.CareerSite) error
	DeleteCareerSite(ctx context.Context, id int64) error

	// runs
	InsertRun(ctx context.Context, r *model.Run) error
	FinishRun(ctx context.Context, r *model.Run) error
	GetRun(ctx context.Context, id int64) (*model.Run, error)
	ListRuns(ctx context.Context, userID *int64, limit int) ([]model.Run, error)
	AppendRunEvent(ctx context.Context, e *model.RunEvent) error
	ListRunEvents(ctx context.Context, runID int64, afterID int64) ([]model.RunEvent, error)

	// stats + settings + llm
	UserStats(ctx context.Context, userID int64, since time.Time) (*Stats, error)
	GetSetting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
	InsertLLMCall(ctx context.Context, c *LLMCall) error
	// CountHHResumesCreatedToday counts hh_resumes with is_generated=1 synced today (pool expand limit).
	CountHHResumesCreatedToday(ctx context.Context, userID int64, day time.Time) (int, error)
}

// LLMCall is one `claude -p` invocation, logged for cost/latency visibility.
type LLMCall struct {
	RunID       int64
	Task        string
	Model       string
	PromptChars int
	ResultChars int
	DurationMS  int64
	OK          bool
	Error       string
	Attempt     int
}
