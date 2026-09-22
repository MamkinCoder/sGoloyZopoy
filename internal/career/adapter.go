// Package career defines the adapter interface for company career sites and a registry.
// Contract file: workstream F implements generic/ and the registry; runner (G) consumes it.
package career

import (
	"context"

	"github.com/MamkinCoder/sGoloyZopoy/internal/browser"
	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// SiteConfig is career_sites.config_json decoded. Keys are adapter-specific; the generic adapter
// uses: list_url, card_selector, title_selector, link_selector, next_selector, scroll (bool),
// desc_selector, apply_button_text, form fields map.
type SiteConfig struct {
	BaseURL string
	Raw     map[string]any
}

// Discovered is a vacancy found on a listing page, not yet fetched.
type Discovered struct {
	ExternalID string // stable per site (URL path or id)
	URL        string
	Title      string
	Company    string
}

// ApplyRequest carries everything the adapter needs to submit one application.
type ApplyRequest struct {
	Vacancy     *model.Vacancy
	Profile     *model.Profile
	ResumePDF   string // absolute path
	CoverLetter string
	// AnswerQuestions is called for any extra form questions.
	AnswerQuestions func(ctx context.Context, qs []model.Question) ([]model.Answer, error)
	DryRun          bool
}

type ApplyResult struct {
	Status       model.Status
	ReasonDetail string
	SnapshotPath string
	Questions    []model.Question
	Answers      []model.Answer
}

// Adapter is implemented once per career site (or once for a family of sites, e.g. generic).
type Adapter interface {
	Name() string
	Discover(ctx context.Context, s browser.Session, cfg SiteConfig) ([]Discovered, error)
	Fetch(ctx context.Context, s browser.Session, cfg SiteConfig, d Discovered) (*model.Vacancy, error)
	Apply(ctx context.Context, s browser.Session, cfg SiteConfig, req ApplyRequest) (*ApplyResult, error)
}

// Registry maps adapter name → implementation.
type Registry interface {
	Get(name string) (Adapter, bool)
	Names() []string
}
