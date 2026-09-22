// Package state parses the JSON page model hh.ru embeds in every page:
//
//	<template id="HH-Lux-InitialState">{ ...json... }</template>
//
// Reading this is far more stable than scraping CSS. extract.go is shared; search.go/vacancy.go are
// owned by workstream B, resumes.go/negotiations.go by workstream C. Each parser takes the raw JSON
// and returns typed structs; unknown layout → return an error, never panic.
package state

import (
	"encoding/json"
	"errors"
	"html"
	"regexp"
	"strings"
)

var tmplRe = regexp.MustCompile(`(?s)<template[^>]*id="HH-Lux-InitialState"[^>]*>(.*?)</template>`)

// ErrNotFound is returned when the page has no InitialState template.
var ErrNotFound = errors.New("HH-Lux-InitialState not found")

// Extract finds the InitialState template in pageHTML and returns its JSON.
func Extract(pageHTML string) (json.RawMessage, error) {
	m := tmplRe.FindStringSubmatch(pageHTML)
	if m == nil {
		return nil, ErrNotFound
	}
	raw := strings.TrimSpace(html.UnescapeString(m[1]))
	if !json.Valid([]byte(raw)) {
		return nil, errors.New("HH-Lux-InitialState is not valid JSON")
	}
	return json.RawMessage(raw), nil
}

// Get walks a dotted path ("vacancyView.description") through the JSON and returns the sub-document.
func Get(raw json.RawMessage, path string) (json.RawMessage, bool) {
	cur := raw
	for _, key := range strings.Split(path, ".") {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(cur, &obj); err != nil {
			return nil, false
		}
		next, ok := obj[key]
		if !ok {
			return nil, false
		}
		cur = next
	}
	return cur, true
}
