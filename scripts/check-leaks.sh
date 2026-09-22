#!/usr/bin/env bash
# Leak check for the public repo: scans git-tracked (and staged) files for personal data and secrets.
# Exit 1 on any hit. Run before every push:  pnpm check-leaks   (or: make check-leaks)
#
# Generic checks (always on):
#   - forbidden tracked paths: data/**, *.pdf, *.db, *.db-*, hh-cookies*.json, .env* (except data.example/.env.example)
#   - Russian phone numbers, e-mail addresses (placeholders like @example.com / @email.com are allowed)
#   - hh.ru session cookie name, Telegram bot tokens, TG_BOT_TOKEN / SGZ_PANEL_PASSWORD with a real value,
#     Anthropic / GitHub / Slack-style API keys
# Custom patterns: data/scrub.json (gitignored) with the format  {"patterns": ["Иванов", "+7 921", "my-company"]}
#   Each entry is matched as a case-insensitive fixed string in every tracked text file.
# Portable: BSD grep on macOS (no -P, no \d), GNU grep on Linux.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo" >&2; exit 2; }
cd "$ROOT"
SELF="scripts/check-leaks.sh"
SCRUB="${SGZ_SCRUB:-data/scrub.json}"
hits=0
red() { printf '\033[1;31m%s\033[0m\n' "$*"; }

# Tracked + staged (new files added with git add show up in ls-files too).
LIST="$(mktemp "${TMPDIR:-/tmp}/sgz-leak.XXXXXX")"
trap 'rm -f "$LIST" "$LIST.pat"' EXIT
git ls-files -z --cached --others --exclude-standard | tr '\0' '\n' | grep -v "^$SELF\$" > "$LIST"

report() { # $1 = check name, $2 = matches (empty = clean). Not a pipeline: $hits must survive.
  [[ -z "${2:-}" ]] && return 0
  red "[$1]"
  printf '%s\n' "$2" | head -40 | sed 's/^/  /'
  hits=$((hits + 1))
}

scan() { # $1 = name, $2 = ERE, $3 = allow-ERE (matching lines dropped), $4 = extra grep flags
  local name="$1" re="$2" allow="${3:-}" flags="${4:-}" out
  # shellcheck disable=SC2086
  out="$(tr '\n' '\0' < "$LIST" | xargs -0 grep -nIE $flags -- "$re" 2>/dev/null \
    | { if [[ -n "$allow" ]]; then grep -vE -- "$allow"; else cat; fi; })" || true
  report "$name" "$out"
}

# 1. forbidden paths
bad_paths="$(grep -E '(^|/)data/|\.pdf$|\.db$|\.db-[a-z]+$|(^|/)hh-cookies[^/]*\.json$|(^|/)\.env([^/]*)?$' "$LIST" \
  | grep -vE '^data\.example/' || true)"
report "forbidden tracked file" "$bad_paths"

# 2. personal data
scan "phone number" \
  '(\+7|[^0-9A-Za-z_./-]8)[ (-]?[0-9]{3}[ )-]?[0-9]{3}[ -]?[0-9]{2}[ -]?[0-9]{2}' \
  '000[ -]?00[ -]?00|0000000000|900 000'
scan "e-mail address" \
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  '@(example\.(com|org|net)|email\.com|company\.com|domain\.com|anthropic\.com|users\.noreply\.github\.com)'

# 3. secrets
# A real cookie dump has a long value next to the name; a scrub rule / selector only mentions the name.
scan "hh.ru session cookie value" 'hh(token|uid)"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_%.-]{16,}' '' '-i'
scan "telegram bot token" '[0-9]{8,10}:[A-Za-z0-9_-]{35}'
scan "TG_BOT_TOKEN with a value" 'TG_BOT_TOKEN=[^ "'"'"'$<,)]+' 'TG_BOT_TOKEN=(\.\.\.|xxx|<|[A-Za-z_-]*(test|token|dummy|fake|example)[A-Za-z_-]*\b)'
scan "TG_CHAT_ID with a value" 'TG_CHAT_ID=-?[0-9]{5,}'
scan "SGZ_PANEL_PASSWORD with a value" 'SGZ_PANEL_PASSWORD=[^ "'"'"'$<,)]+' 'SGZ_PANEL_PASSWORD=(change-me|\.\.\.|xxx|<|[A-Za-z_-]*(test|secret|dummy|fake|example|pw|pass)[A-Za-z_-]*\b)'
scan "API key" 'sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bpa]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}'

# 4. custom patterns from data/scrub.json
if [[ -f "$SCRUB" ]]; then
  if command -v node >/dev/null 2>&1; then
    node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const p of (j.patterns||[]))if(String(p).trim())console.log(String(p))' "$SCRUB" > "$LIST.pat" \
      || { red "cannot parse $SCRUB (expected {\"patterns\": [\"...\"]})"; hits=$((hits + 1)); }
    if [[ -s "$LIST.pat" ]]; then
      custom="$(tr '\n' '\0' < "$LIST" | xargs -0 grep -nIiF -f "$LIST.pat" -- 2>/dev/null || true)"
      report "custom pattern ($SCRUB)" "$custom"
      echo "custom patterns checked: $(wc -l < "$LIST.pat" | tr -d ' ') from $SCRUB"
    fi
  else
    red "node not found - cannot read $SCRUB"; hits=$((hits + 1))
  fi
else
  echo "note: no $SCRUB - only generic checks ran (create it with {\"patterns\": [\"your surname\", \"your phone\"]})"
fi

if [[ "$hits" -gt 0 ]]; then
  red "LEAK CHECK FAILED: $hits check(s) hit. Fix or allow-list before pushing."
  exit 1
fi
echo "leak check OK: $(wc -l < "$LIST" | tr -d ' ') files scanned"
