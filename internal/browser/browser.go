// Package browser wraps go-rod. It is the ONLY package that talks to Chromium.
// Contract file: workstream B implements it; everyone else codes against these types.
package browser

import (
	"context"
	"time"
)

// Options configures a browser Session.
//
// Implementation notes (workstream B): go-rod with launcher.New().Bin(opts.Bin) — NEVER let rod download
// its own Chromium (no linux-arm64 build). Leakless(false). Flags: --headless=new --disable-gpu
// --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-extensions
// --disable-background-networking --disable-sync --renderer-process-limit=2 --lang=ru-RU
// --window-size=1366,850 --disk-cache-dir=<tmp> --disk-cache-size=50000000. No --no-sandbox,
// no --single-process. Use rod/lib/stealth for pages. Hijack and abort images/fonts/media/analytics
// requests (BlockAssets) to cut RAM and bandwidth on the Pi.
type Options struct {
	Bin         string        // chromium binary; required on Linux ($CHROMIUM_BIN); on macOS default to Google Chrome
	Headless    bool          // false only for `sgz hh-login`
	UserDataDir string        // PERSISTENT per-user profile: data/users/<slug>/chrome-profile (fingerprint stability)
	CacheDir    string        // disk cache; /tmp on the Pi
	UserAgent   string        // fixed Linux Chrome UA, identical on Mac login and on the Pi
	SnapshotDir string        // where Snapshot() writes html+png
	BlockAssets bool          // hijack: abort image/font/media/analytics requests
	Timeout     time.Duration // default per-action timeout
}

// Cookie mirrors the CDP Network.Cookie fields we persist.
type Cookie struct {
	Name     string  `json:"name"`
	Value    string  `json:"value"`
	Domain   string  `json:"domain"`
	Path     string  `json:"path"`
	Expires  float64 `json:"expires"`
	HTTPOnly bool    `json:"httpOnly"`
	Secure   bool    `json:"secure"`
	SameSite string  `json:"sameSite,omitempty"`
}

// Session is one Chromium instance with one active page. Not safe for concurrent use.
type Session interface {
	// Navigate loads url and waits for the page to be idle.
	Navigate(ctx context.Context, url string) error
	// HTML returns the current document outerHTML.
	HTML(ctx context.Context) (string, error)
	// Eval runs JS in the page and JSON-decodes the result into out (out may be nil).
	Eval(ctx context.Context, js string, out any) error
	// ClickByText clicks the first visible element among selector whose trimmed textContent == text.
	ClickByText(ctx context.Context, selector, text string) error
	// ClickSelector clicks the first visible element matching a CSS selector.
	ClickSelector(ctx context.Context, selector string) error
	// SetReactInput sets value on an <input>/<textarea> the React way (native setter + input event).
	SetReactInput(ctx context.Context, selector, value string) error
	// UploadFile attaches a local file to an <input type=file>.
	UploadFile(ctx context.Context, selector, path string) error
	// WaitText polls until text appears anywhere in document.body or timeout elapses.
	WaitText(ctx context.Context, text string, timeout time.Duration) (bool, error)
	// WaitSelector polls until selector exists or timeout elapses.
	WaitSelector(ctx context.Context, selector string, timeout time.Duration) (bool, error)
	// Exists reports whether selector currently matches.
	Exists(ctx context.Context, selector string) (bool, error)
	// TextOf returns trimmed textContent of the first match ("" if none).
	TextOf(ctx context.Context, selector string) (string, error)
	// Snapshot writes <name>.html, <name>.png and <name>.url into Options.SnapshotDir and returns the html path.
	Snapshot(ctx context.Context, name string) (string, error)
	// TypeHuman types text into the focused element with per-key jitter (for search boxes / chat inputs).
	TypeHuman(ctx context.Context, selector, text string) error
	// Cookies exports all cookies of the browser context.
	Cookies(ctx context.Context) ([]Cookie, error)
	// SetCookies injects cookies into the browser context.
	SetCookies(ctx context.Context, cookies []Cookie) error
	// URL returns the current page URL.
	URL(ctx context.Context) (string, error)
	// Close kills the browser.
	Close() error
}

// Launcher creates Sessions. The runner holds exactly one Launcher and opens one Session at a time.
type Launcher interface {
	Launch(ctx context.Context, opts Options) (Session, error)
}
