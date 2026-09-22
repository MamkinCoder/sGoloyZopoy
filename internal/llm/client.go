// Package llm wraps `claude -p` (Claude Code headless) with typed prompts.
// Contract file: workstream D implements it; runner/hh/resume code calls these methods.
package llm

import (
	"context"

	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// Tier selects the model: cheap classification vs. writing vs. full resume tailoring.
type Tier string

const (
	TierFast   Tier = "haiku"
	TierWrite  Tier = "sonnet"
	TierTailor Tier = "opus"
)

// DecideInput is the batch input for decide_hh.
type DecideInput struct {
	Profile   *model.Profile
	Resumes   []model.HHResume // pool with summaries
	Vacancies []*model.Vacancy // up to 10
}

// ProposeVariantsInput is the input for propose_pool_variants.
type ProposeVariantsInput struct {
	Profile  *model.Profile
	Existing []model.HHResume
	Max      int
}

// PoolVariant is one proposed hh resume variant.
type PoolVariant struct {
	Title           string   `json:"title"`
	About           string   `json:"about"`
	KeySkills       []string `json:"key_skills"`
	BasedOnResumeID string   `json:"based_on_resume_id"`
	Direction       string   `json:"direction"`
}

// TailorInput is the input for tailor_cv.
type TailorInput struct {
	Profile *model.Profile
	Base    *model.CV
	Vacancy *model.Vacancy
}

// TailorOutput is tailor_cv's result.
type TailorOutput struct {
	CV      model.CV `json:"cv"`
	Changes []string `json:"changes"`
}

// ChatReply is answer_chat's result.
type ChatReply struct {
	Reply      string `json:"reply"`
	NeedsHuman bool   `json:"needs_human"`
}

// Client is the typed LLM surface. Every method is one `claude -p` invocation.
type Client interface {
	// Decide classifies vacancies and picks a resume + cover letter for each. One call per batch.
	Decide(ctx context.Context, in DecideInput) ([]model.Decision, error)
	// AnswerQuestionnaire answers hh / career-site form questions from profile facts.
	AnswerQuestionnaire(ctx context.Context, p *model.Profile, v *model.Vacancy, qs []model.Question) ([]model.Answer, error)
	// AnswerChat drafts a reply to an employer / bot thread. Reply=="" with NeedsHuman=true → do not send.
	AnswerChat(ctx context.Context, p *model.Profile, v *model.Vacancy, history []model.ChatMessage) (ChatReply, error)
	// SummarizeResume produces the ResumeSummary used for selection.
	SummarizeResume(ctx context.Context, resumeText string) (model.ResumeSummary, error)
	// ProposePoolVariants suggests new hh resume variants to create.
	ProposePoolVariants(ctx context.Context, in ProposeVariantsInput) ([]PoolVariant, error)
	// TailorCV rewrites a base CV for one vacancy (career sites).
	TailorCV(ctx context.Context, in TailorInput) (TailorOutput, error)
	// CoverLetterCareer writes a cover letter for a career-site application.
	CoverLetterCareer(ctx context.Context, p *model.Profile, cv *model.CV, v *model.Vacancy) (string, error)
}
