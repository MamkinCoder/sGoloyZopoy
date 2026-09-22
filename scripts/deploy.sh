#!/usr/bin/env bash
# Build on the Mac, ship to the Pi, restart the service. Usage: scripts/deploy.sh [--no-build] [--no-restart]
#   PI_HOST=rpi-ts (ssh alias)  PI_APP=/opt/sgz/app
# Steps: typecheck -> build web + server -> web/dist -> server/spa -> stage the runtime file set -> rsync (--delete)
#        -> on the Pi: keep a copy in /opt/sgz/app.prev (rollback), pnpm install --prod, restart sgz, show logs.
# Portable: macOS ships openrsync + BSD sed/cp, so no GNU-only flags here.
set -euo pipefail

PI_HOST="${PI_HOST:-rpi-ts}"
PI_APP="${PI_APP:-/opt/sgz/app}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1 RESTART=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-restart) RESTART=0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
cd "$ROOT"

if [[ "$BUILD" == 1 ]]; then
  step "typecheck + build (web, server)"
  pnpm -r typecheck
  pnpm --filter @sgz/shared build
  pnpm --filter @sgz/web build
  pnpm --filter @sgz/server build
fi
[[ -f packages/server/dist/cli.js ]] || { echo "packages/server/dist/cli.js missing - build first" >&2; exit 1; }
[[ -d packages/web/dist ]] || { echo "packages/web/dist missing - build first" >&2; exit 1; }
[[ -f packages/shared/dist/index.js ]] || { echo "packages/shared/dist/index.js missing - build shared first" >&2; exit 1; }

step "embed SPA: packages/web/dist -> packages/server/spa"
rm -rf packages/server/spa
cp -R packages/web/dist packages/server/spa

step "stage runtime file set"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/sgz-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
# Everything the Pi needs to `pnpm install --prod` and run `node packages/server/dist/cli.js`.
# Shared runtime code is compiled: Node cannot execute TypeScript dependencies in node_modules.
# CLAUDE.md + .claude/ are the cwd contents `claude -p` reads (SGZ_REPO_DIR=/opt/sgz/app).
FILES=(
  package.json pnpm-workspace.yaml pnpm-lock.yaml
  CLAUDE.md .claude
  deploy scripts docs
  packages/server/package.json packages/server/dist packages/server/prompts packages/server/spa
  packages/server/src/db/migrations
  packages/shared/package.json packages/shared/src packages/shared/tsconfig.json
  packages/web/package.json
)
[[ -d prompts ]] && FILES+=(prompts)
[[ -d packages/shared/dist ]] && FILES+=(packages/shared/dist)
for f in "${FILES[@]}"; do
  if [[ ! -e "$f" ]]; then echo "  skip (missing): $f"; continue; fi
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -R "$f" "$STAGE/$f"
done
# Runtime assets are resolved relative to emitted modules, not the source tree.
mkdir -p "$STAGE/packages/server/dist/db/migrations"
cp packages/server/src/db/migrations/*.sql "$STAGE/packages/server/dist/db/migrations/"
cp packages/server/src/resume/template.tex "$STAGE/packages/server/dist/resume/template.tex"
node --input-type=module - "$STAGE/packages/shared/package.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const pkg = JSON.parse(readFileSync(path, 'utf8'));
pkg.main = './dist/index.js';
pkg.types = './dist/index.d.ts';
pkg.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
NODE
# Never ship secrets or local state, even if they sit inside a staged dir.
find "$STAGE" \( -name '.env*' -o -name '*.db' -o -name '*.db-*' -o -name 'hh-cookies*.json' -o -name '.DS_Store' -o -name 'node_modules' \) -prune -exec rm -rf {} + 2>/dev/null || true
printf '%s\n' "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown) $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/RELEASE"
du -sh "$STAGE" | awk '{print "  staged:", $1}'

step "rsync -> $PI_HOST:$PI_APP (keeping the previous release in ${PI_APP}.prev)"
# Snapshot the current release on the Pi first (local copy, fast after the first time) for `make rollback`.
ssh "$PI_HOST" "mkdir -p '$PI_APP' && if [ -f '$PI_APP/RELEASE' ]; then rsync -a --delete '$PI_APP/' '${PI_APP}.prev/'; fi"
rsync -az --delete \
  --exclude node_modules --exclude 'packages/*/node_modules' --exclude data \
  "$STAGE/" "$PI_HOST:$PI_APP/"

step "on the Pi: pnpm install --prod --frozen-lockfile (Node 22)"
ssh "$PI_HOST" "cd '$PI_APP' && export PATH=/usr/local/bin:\$PATH && node --version && pnpm install --prod --frozen-lockfile --filter '@sgz/server...'"

if [[ "$RESTART" == 1 ]]; then
  step "restart sgz"
  ssh "$PI_HOST" "sudo systemctl restart sgz && sleep 4 && echo \"sgz: \$(systemctl is-active sgz)\"; journalctl -u sgz -n 20 --no-pager"
  ssh "$PI_HOST" "systemctl is-active --quiet sgz" || { echo "sgz is not active - see journalctl -u sgz; rollback: make rollback" >&2; exit 1; }
else
  echo "skipped restart (--no-restart); run: ssh $PI_HOST sudo systemctl restart sgz"
fi
step "deployed $(cat "$STAGE/RELEASE")"
