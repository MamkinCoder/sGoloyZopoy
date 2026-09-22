// Package config loads runtime configuration from env / data/.env.
// Contract file: workstream A implements Load(); fields are fixed here.
package config

import "time"

type Config struct {
	DataDir       string        // SGZ_DATA_DIR, default ./data
	Bind          string        // SGZ_BIND, default 0.0.0.0:3002
	PanelPassword string        // SGZ_PANEL_PASSWORD
	TGBotToken    string        // TG_BOT_TOKEN
	TGChatID      string        // TG_CHAT_ID (shared chat)
	ChromiumBin   string        // CHROMIUM_BIN, empty → auto
	ClaudeBin     string        // CLAUDE_BIN, default "claude"
	RepoDir       string        // SGZ_REPO_DIR — cwd for claude -p (needs CLAUDE.md + .claude/skills); default: executable's dir or "."
	XelatexBin    string        // XELATEX_BIN, default "xelatex"
	ScheduleAt    string        // SGZ_SCHEDULE, "12:00" local; empty → scheduler off
	RunnerEnabled bool          // SGZ_RUNNER, default true; false → panel only (fallback when Pi can't run browser)
	PanelURL      string        // SGZ_PANEL_URL for links in Telegram, e.g. http://sgz.rp.i
	ThrottleMin   time.Duration // SGZ_THROTTLE_MIN, default 8s
	ThrottleMax   time.Duration // SGZ_THROTTLE_MAX, default 20s
	UserAgent     string        // SGZ_USER_AGENT, fixed Linux Chrome UA
}

// Paths derived from DataDir.
func (c Config) DBPath() string             { return c.DataDir + "/sgz.db" }
func (c Config) UserDir(slug string) string { return c.DataDir + "/users/" + slug }
func (c Config) CookiesFile(slug string) string {
	return c.UserDir(slug) + "/hh-cookies.json"
}
func (c Config) ProfileFile(slug string) string { return c.UserDir(slug) + "/profile.yaml" }
func (c Config) CVDir(slug string) string       { return c.UserDir(slug) + "/cv" }
func (c Config) TexDir(slug string) string      { return c.UserDir(slug) + "/tex" }
func (c Config) GeneratedDir(slug string) string {
	return c.UserDir(slug) + "/generated"
}
func (c Config) SnapshotDir() string { return c.DataDir + "/snapshots" }
