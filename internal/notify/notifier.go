// Package notify sends Telegram messages. Contract file: workstream G implements telegram.go.
package notify

import (
	"context"

	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

type Notifier interface {
	// Report sends the end-of-run summary for a user to the shared chat.
	Report(ctx context.Context, u *model.User, run *model.Run) error
	// Alert sends an operational alert (captcha, login expired, run crashed, OOM-ish) to the shared chat.
	Alert(ctx context.Context, title, body string) error
}

// Noop is used in tests and when TG_BOT_TOKEN is not set.
type Noop struct{}

func (Noop) Report(context.Context, *model.User, *model.Run) error { return nil }
func (Noop) Alert(context.Context, string, string) error           { return nil }
