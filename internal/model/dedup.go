package model

import (
	"crypto/sha1"
	"encoding/hex"
	"regexp"
	"strings"
)

var nonAlnum = regexp.MustCompile(`[^\p{L}\p{N}]+`)

var legalPrefixes = regexp.MustCompile(`(?i)^(ооо|ао|зао|пао|ип|оао|ано|llc|ltd|inc)\s+`)

// NormalizeDedup builds the dedup_hash for a vacancy: lowercase, strip legal-form prefixes,
// collapse punctuation. Same company + same title → same hash regardless of source.
func NormalizeDedup(company, title string) string {
	c := strings.ToLower(strings.TrimSpace(company))
	c = legalPrefixes.ReplaceAllString(c, "")
	c = nonAlnum.ReplaceAllString(c, " ")
	t := strings.ToLower(strings.TrimSpace(title))
	t = nonAlnum.ReplaceAllString(t, " ")
	key := strings.TrimSpace(c) + "|" + strings.TrimSpace(t)
	sum := sha1.Sum([]byte(key))
	return hex.EncodeToString(sum[:])
}
