#!/usr/bin/env bash
# Offline stand-in for the `claude` binary. Behaviour via env:
#   STUB_DIR        dir for counter/argv/prompt/timeline files (required)
#   STUB_MODE       valid | fenced | prose | garbage_then_valid | is_error | exit1 | sleep | structured | raw
#   STUB_RESULT     the model "text" (or JSON) to return; STUB_RESULT_FILE overrides with a file
#   STUB_SLEEP      seconds to sleep in sleep mode (default 5)
#   STUB_HELP_FLAGS flags advertised by --help (default: --json-schema --no-session-persistence --tools)
set -u
if [ "${1:-}" = "--help" ]; then
  echo "Usage: claude [options] [command] [prompt]"
  echo "Options:"
  for f in ${STUB_HELP_FLAGS-"--json-schema --no-session-persistence --tools"}; do echo "  $f <x>  stubbed"; done
  exit 0
fi
dir="${STUB_DIR:?STUB_DIR required}"
mkdir -p "$dir"
now() { node -e 'console.log(Date.now())'; }
echo "start $(now)" >> "$dir/timeline"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\n' "$*" >> "$dir/argv.log"
cat > "$dir/prompt-$n.txt"
mode="${STUB_MODE:-valid}"
if [ -n "${STUB_RESULT_FILE:-}" ]; then
  result=$(cat "$STUB_RESULT_FILE")
elif [ -n "${STUB_RESULT:-}" ]; then
  result="$STUB_RESULT"
else
  result="{}"
fi

envelope() { # $1 = text, $2 = is_error, $3 = structured json or empty
  RES="$1" ERR="$2" STRUCT="${3:-}" node -e '
    const o = { type: "result", subtype: process.env.ERR === "true" ? "error_during_execution" : "success",
      is_error: process.env.ERR === "true", result: process.env.RES, session_id: "stub", duration_ms: 1 };
    if (process.env.STRUCT) o.structured_output = JSON.parse(process.env.STRUCT);
    console.log(JSON.stringify(o));'
}

case "$mode" in
  valid) envelope "$result" false ;;
  fenced) envelope "Вот ответ:
\`\`\`json
$result
\`\`\`
Готово." false ;;
  prose) envelope "Конечно! Вот JSON, который вы просили: $result Надеюсь, это поможет." false ;;
  garbage_then_valid) if [ "$n" -eq 1 ]; then envelope "Не могу ответить в таком формате." false; else envelope "$result" false; fi ;;
  is_error) envelope "Invalid API key" true ;;
  exit1) echo "boom: stub failure" >&2; exit 1 ;;
  sleep) trap 'kill $child 2>/dev/null; echo "killed $(now)" >> "$dir/timeline"; exit 143' TERM INT
         sleep "${STUB_SLEEP:-5}" & child=$!; wait $child; envelope "$result" false ;;
  structured) envelope "" false "$result" ;;
  raw) printf '%s\n' "$result" ;;
  *) echo "unknown STUB_MODE $mode" >&2; exit 2 ;;
esac
echo "end $(now)" >> "$dir/timeline"
