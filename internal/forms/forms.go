// Package forms turns any DOM form (hh questionnaire after «Откликнуться», hh chat-bot survey widget,
// career-site application form) into a generic model the LLM can answer, and fills answers back in.
// Contract file: workstream B implements Extract/Fill; llm (D) answers model.Question; everyone else
// only passes the values through.
package forms

import (
	"context"

	"github.com/MamkinCoder/sGoloyZopoy/internal/browser"
	"github.com/MamkinCoder/sGoloyZopoy/internal/model"
)

// Field is one answerable control with a stable locator so Fill can find it again.
type Field struct {
	model.Question
	Locator        string   // CSS selector (prefer [data-qa], id, name; xpath fallback prefixed "xpath=")
	OptionLocators []string // one per Question.Options for radio/checkbox
	MaxLen         int
}

// Model is a whole form as seen on the page.
type Model struct {
	Title         string
	Fields        []Field
	SubmitLocator string
	Root          string // selector scoping the form (modal / widget), "" = document
}

// Questions returns the LLM-facing view of the form.
func (m *Model) Questions() []model.Question {
	qs := make([]model.Question, len(m.Fields))
	for i, f := range m.Fields {
		qs[i] = f.Question
		qs[i].Idx = i
	}
	return qs
}

// Extractor finds forms on the current page.
type Extractor interface {
	// Extract scans `root` (or the document) for a form-like region and returns its Model.
	// Returns (nil, nil) if no answerable fields are found.
	Extract(ctx context.Context, s browser.Session, root string) (*Model, error)
}

// Filler applies answers to a Model on the current page. It does NOT submit.
type Filler interface {
	Fill(ctx context.Context, s browser.Session, m *Model, answers []model.Answer) error
}
