// Package hh drives hh.ru through a browser.Session.
// Contract file: workstream B implements search/vacancy/apply, workstream C implements chats/resumes.
package hh

import (
	"context"

	"github.com/MamkinCoder/sGoloyZopoy/internal/browser"
	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// SearchParams describes one search page request.
type SearchParams struct {
	Query        string
	Period       int // days, default 1
	Page         int
	ItemsOnPage  int // default 50
	ExcludeWords []string
}

// Card is one item from the search results page (not yet fetched).
type Card struct {
	ExternalID string
	URL        string
	Title      string
	Company    string
	SalaryRaw  string
}

// ApplyRequest carries everything needed to apply to one vacancy.
type ApplyRequest struct {
	Vacancy     *model.Vacancy
	ResumeTitle string // HHResume.Title — resume is chosen by title in the modal
	CoverLetter string
	// AnswerQuestions is called if a questionnaire appears; it must return one Answer per Question.
	AnswerQuestions func(ctx context.Context, qs []model.Question) ([]model.Answer, error)
	DryRun          bool
}

// ApplyResult is the outcome of ApplyRequest.
type ApplyResult struct {
	Status       model.Status
	ReasonDetail string
	SnapshotPath string // set on FAILED_*
	Questions    []model.Question
	Answers      []model.Answer
}

// Implementation notes (workstreams B, C):
//   - hh.ru embeds the page model as JSON in <template id="HH-Lux-InitialState">…</template>.
//     READ from that (search results, vacancy incl. description/hasTest/responseLetterRequired,
//     resumes list, negotiations list); use the DOM only for ACTIONS. Parsers live in hh/state and are
//     tested against scrubbed fixtures in hh/testdata.
//   - All data-qa / CSS selectors live in selectors.go — one place to fix when hh changes markup.
//   - After submit, confirmation comes from STATE: re-navigate to the vacancy and require the
//     «Вы откликнулись» marker in InitialState/DOM; otherwise FAILED_NO_CONFIRMATION + snapshot.
//   - DetectAntiBot must recognise: captcha page, «подозрительная активность», 403/429 pages,
//     redirect to /account/login (→ model.ErrLoginExpired).
//
// Client is the hh.ru automation surface used by the runner.
type Client interface {
	// CheckLogin verifies the session is authenticated (e.g. by loading /applicant/resumes).
	CheckLogin(ctx context.Context, s browser.Session) (bool, error)
	// Search returns cards from one results page. Returns (nil, nil) when the page is empty.
	Search(ctx context.Context, s browser.Session, p SearchParams) ([]Card, error)
	// FetchVacancy opens the vacancy page and fills in description, salary, has_test, requires_letter.
	// Sets alreadyApplied=true when the page shows «Вы откликнулись».
	FetchVacancy(ctx context.Context, s browser.Session, c Card) (v *model.Vacancy, alreadyApplied bool, err error)
	// Apply performs the full apply flow on the currently loaded vacancy page.
	Apply(ctx context.Context, s browser.Session, req ApplyRequest) (*ApplyResult, error)
	// DetectAntiBot reports whether the current page shows a captcha / suspicious-activity block.
	DetectAntiBot(ctx context.Context, s browser.Session) (bool, error)

	// SyncResumes scrapes /applicant/resumes and returns the user's resumes (no LLM summary yet).
	SyncResumes(ctx context.Context, s browser.Session) ([]model.HHResume, error)
	// ResumeText opens a resume page and returns its plain text (for summarize_resume).
	ResumeText(ctx context.Context, s browser.Session, r model.HHResume) (string, error)
	// DuplicateResume duplicates baseResumeID and edits title / about / key skills; returns the new hh_resume_id.
	DuplicateResume(ctx context.Context, s browser.Session, baseResumeID string, edit ResumeEdit) (string, error)
	// TouchResume clicks «Поднять в поиске» / «Обновить дату» on a resume.
	TouchResume(ctx context.Context, s browser.Session, r model.HHResume) error
	// ResumeCapacity returns (created, max) from the resumes page, max=20 if not shown.
	ResumeCapacity(ctx context.Context, s browser.Session) (created, max int, err error)

	// ListThreads returns negotiation threads, unread first.
	ListThreads(ctx context.Context, s browser.Session, onlyUnread bool) ([]model.ChatThread, error)
	// ReadThread opens a thread and returns its messages in chronological order plus the current state.
	ReadThread(ctx context.Context, s browser.Session, t model.ChatThread) ([]model.ChatMessage, string, error)
	// SendMessage posts text into the thread's chat input.
	SendMessage(ctx context.Context, s browser.Session, t model.ChatThread, text string) error
	// SurveyQuestions returns structured questions if the thread shows a chat-bot survey widget.
	SurveyQuestions(ctx context.Context, s browser.Session, t model.ChatThread) ([]model.Question, error)
	// SubmitSurvey fills the survey widget with answers and submits it.
	SubmitSurvey(ctx context.Context, s browser.Session, t model.ChatThread, answers []model.Answer) error
}

// ResumeEdit is what DuplicateResume changes on the copy.
type ResumeEdit struct {
	Title     string
	About     string
	KeySkills []string
}

// Recorder drives the real flow up to (not including) the final submit and saves a snapshot bundle at
// every step (html+png+url+state.json) so parsers and the apply flow can be developed offline.
// `sgz hh-record --user u --vacancy <id|url> [--negotiation <id>]` → data/recordings/<ts>/.
type Recorder interface {
	RecordVacancyFlow(ctx context.Context, s browser.Session, vacancyURL, outDir string) error
	RecordNegotiations(ctx context.Context, s browser.Session, negotiationID, outDir string) error
	RecordResumes(ctx context.Context, s browser.Session, outDir string) error
}
