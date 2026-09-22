# Constructor signatures (agreed across workstreams)

Everyone codes against the interfaces in the contract files. These are the concrete constructors
each package MUST export with exactly this signature so `cmd/sgz` wiring compiles at integration.

```go
// internal/config  (A)
func Load() (config.Config, error)                       // env + $SGZ_DATA_DIR/.env, defaults applied
func (c Config) EnsureDirs() error                       // mkdir -p data dirs

// internal/store  (A)
func Open(path string) (store.Store, error)             // opens sqlite, applies migrations

// internal/browser  (B)
func NewLauncher() browser.Launcher
func DefaultUserAgent() string                           // fixed Linux Chrome UA
func LoadCookies(path string) ([]browser.Cookie, error)
func SaveCookies(path string, cookies []browser.Cookie) error
// internal/browser/fake  (B)
type Session struct{ ... }                               // scripted fake implementing browser.Session for tests

// internal/forms  (B)
func NewExtractor() forms.Extractor
func NewFiller() forms.Filler

// internal/hh  (B, C)
func NewWebClient(ext forms.Extractor, fill forms.Filler, snapshotDir string) *hh.WebClient   // exists
func NewRecorder(c *hh.WebClient) hh.Recorder            // B
func LoginInteractive(ctx, l browser.Launcher, opts browser.Options, cookiesOut string) error  // B: hh-login

// internal/career  (F)
func NewRegistry() career.Registry                       // with "generic" registered

// internal/llm  (D)
func New(cfg config.Config, calls store.LLMCallSink) llm.Client
// where store.LLMCallSink is: interface{ InsertLLMCall(ctx, *store.LLMCall) error } — pass the Store.

// internal/resume  (E)
func LoadCV(path string) (*model.CV, error)
func SaveCV(path string, cv *model.CV) error
func ImportTex(tex []byte) (*model.CV, []string /*warnings*/, error)
func Render(cv *model.CV) ([]byte, error)                // → .tex
func Build(ctx, xelatexBin, texDir, texPath, outPDF string) error
func Validate(base, tailored *model.CV, neverClaim []string) []string

// internal/notify  (G)
func NewTelegram(token, chatID, panelURL string) notify.Notifier

// internal/runner  (G)
type Deps struct { Cfg config.Config; Store store.Store; Launcher browser.Launcher; HH hh.Client;
                   LLM llm.Client; Career career.Registry; Notifier notify.Notifier; Version string }
func New(d Deps) runner.Service
var ErrBusy error

// internal/scheduler  (G)
func New(svc runner.Service, at string /*"12:00"*/, tz string, jitter time.Duration) *scheduler.Scheduler
func (s *Scheduler) Start(ctx) ; func (s *Scheduler) Next() time.Time

// internal/api  (H)
func New(d api.Deps) http.Handler

// internal/sysinfo  (J)
func MemAvailableMB() (int, error)
func Snapshot() sysinfo.Info                             // mem, disk, versions of chromium/claude/xelatex
```

Rule: if you need to change one of these, do NOT — add a new function instead and mention it in
your final report; the integrator reconciles.
