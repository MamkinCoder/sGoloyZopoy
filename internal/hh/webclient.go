package hh

import (
	"time"

	"github.com/MamkinCoder/sGoloyZopoy/internal/forms"
)

// WebClient implements Client against the hh.ru website. Methods are spread across files:
//
//	search.go, vacancy.go, apply.go, session.go, antibot.go, recorder.go  — workstream B
//	chats.go, resumes.go                                                  — workstream C
//
// Both workstreams add methods to *WebClient; keep unexported helpers prefixed (search*, apply*,
// chat*, resume*) to avoid name clashes inside the package.
type WebClient struct {
	Sel      Selectors
	Forms    forms.Extractor
	Filler   forms.Filler
	Timeout  time.Duration // per-step wait, default 15s
	PollStep time.Duration // default 500ms
	// SnapshotDir receives html+png bundles on FAILED_UI (per run: <dir>/<vacancy>-<step>.html).
	SnapshotDir string
}

// NewWebClient returns a client with default selectors and timeouts.
func NewWebClient(ext forms.Extractor, fill forms.Filler, snapshotDir string) *WebClient {
	return &WebClient{
		Sel:         DefaultSelectors(),
		Forms:       ext,
		Filler:      fill,
		Timeout:     15 * time.Second,
		PollStep:    500 * time.Millisecond,
		SnapshotDir: snapshotDir,
	}
}

// var _ Client = (*WebClient)(nil) // enabled at integration once all methods exist
