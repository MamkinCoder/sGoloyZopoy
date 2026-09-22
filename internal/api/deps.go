// Package api serves the JSON API, SSE run log and the embedded SPA.
// Contract file: workstream H implements New(); cmd/sgz/serve.go (workstream G) calls it.
package api

import (
	"github.com/MamkinCoder/sGoloyZopoy/internal/config"
	"github.com/MamkinCoder/sGoloyZopoy/internal/runner"
	"github.com/MamkinCoder/sGoloyZopoy/internal/store"
)

// Deps is everything the HTTP layer needs. Add fields here (never change existing ones).
type Deps struct {
	Cfg      config.Config
	Store    store.Store
	Runner   runner.Service
	Version  string
	Adapters []string // registered career adapter names
	// HHSessionCheck reports hh.ru session liveness for /api/health; nil → unknown.
	HHSessionCheck func(slug string) (ok bool, checkedAgeHours float64)
	// SchedulerNext returns the next planned run time as RFC3339 or "".
	SchedulerNext func() string
}
