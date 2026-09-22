// Package runner orchestrates a run: stages, limits, throttle, memory guard, events, report.
// Contract file: workstream G implements Service and the stages; api (H) calls Service.
package runner

import (
	"context"
	"time"

	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// Request is what the CLI, the panel and the scheduler submit.
type Request struct {
	UserSlug string // "" or "all" → every active user, sequentially
	Source   string // hh | career | all | pool
	Stage    string // optional single stage: search | apply | chats | pool-sync | pool-expand | touch
	DryRun   bool
	Limit    int // 0 → user's daily limit
	Trigger  model.RunTrigger
}

// Service is the single run queue. Exactly one run executes at a time.
type Service interface {
	// Start enqueues a run and returns its ID. Returns ErrBusy if a run is active.
	Start(ctx context.Context, req Request) (runID int64, err error)
	// Stop cancels the active run (current step finishes, then the run ends with status stopped).
	Stop(ctx context.Context, runID int64) error
	// Active returns the currently running run or nil.
	Active(ctx context.Context) (*model.Run, error)
	// Subscribe returns a channel of events for a run plus an unsubscribe func. Closed when the run ends.
	Subscribe(runID int64) (<-chan model.RunEvent, func())
}

// Logger writes run_events and fans them out to SSE subscribers.
type Logger interface {
	Event(level, stage, message string, data map[string]any)
	Info(stage, message string, data map[string]any)
	Warn(stage, message string, data map[string]any)
	Error(stage, message string, data map[string]any)
}

// MemoryGuard blocks a memory-heavy step until MemAvailable is above needMB, calling release()
// (e.g. close the browser) once if it is not, and returning model.ErrLowMemory if still too low.
type MemoryGuard interface {
	Ensure(ctx context.Context, needMB int, release func()) error
}

// Throttle sleeps a random duration in [min,max] unless ctx is done.
type Throttle interface {
	Wait(ctx context.Context) error
	Bounds() (min, max time.Duration)
}
