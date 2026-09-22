#!/usr/bin/env bash
# One-shot, idempotent host preparation for sGoloyZopoy on the Raspberry Pi.
#
# Run ON the Pi as the `rpi` user (passwordless sudo); the script calls sudo itself where needed:
#   bash /tmp/sgz-install/scripts/install-pi.sh            (see `make install-pi` on the Mac)
# It needs the repo's deploy/ dir next to scripts/ (rsynced there by `make install-pi`, or /opt/sgz/app after a deploy).
#
# What it does (each step prints what it is doing, re-running is safe):
#   1. apt packages: chromium, fonts, TeX (pdflatex + cyrillic + fonts-extra for droidsans/fontawesome5), rsync, sqlite3
#   2. Node 22 side-by-side in /usr/local (Debian's Node 20 at /usr/bin/node stays for sb-webui)
#   3. pnpm + Claude Code CLI installed globally with Node 22
#   4. /opt/sgz/{app,data,bin} owned by rpi, /opt/sgz/bin/sgz wrapper
#   5. systemd unit sgz.service (enabled, NOT started - deploy.sh starts it), journald cap
#   6. OOM protection drop-ins for sing-box / pihole-FTL / unbound (this box is the home gateway)
#   7. nginx vhost sgz.rp.i -> 127.0.0.1:3002
#   8. Pi-hole local DNS record sgz.rp.i -> LAN IP
#   9. Smoke checks: chromium headless, pdflatex/TeX deps, egress to hh.ru + egress IP / country
#  10. Prints the next steps
set -euo pipefail

NODE_MIN="22.18.0"
SGZ_HOST="${SGZ_HOST:-sgz.rp.i}"
SGZ_ROOT=/opt/sgz
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$SCRIPT_DIR/../deploy}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARNING: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -un)" != "root" ]] || die "run as the rpi user, not root (the script uses sudo itself)"
[[ "$(uname -m)" == "aarch64" ]] || die "expected aarch64, got $(uname -m)"
[[ -d "$DEPLOY_DIR" ]] || die "deploy/ dir not found at $DEPLOY_DIR (copy the repo's deploy/ next to scripts/)"
sudo -n true 2>/dev/null || die "passwordless sudo is required"
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)"
ME="$(id -un)"

# ---------------------------------------------------------------- 1. apt
step "apt: update + install runtime packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -q
# --no-install-recommends keeps the multi-hundred-MB texlive-*-doc packages off the SD card.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  chromium fonts-liberation fonts-dejavu fonts-noto-core \
  texlive-latex-base texlive-latex-recommended texlive-latex-extra \
  texlive-fonts-recommended texlive-fonts-extra texlive-lang-cyrillic \
  rsync sqlite3 curl ca-certificates xz-utils
info "chromium: $(chromium --version 2>/dev/null || echo missing)"
info "pdflatex: $(pdflatex --version 2>/dev/null | head -1 || echo missing)"
# The CV class (ReadableCV.cls, memoir-based) is compiled with PDFLATEX; XELATEX_BIN in .env points at it.
# texlive-fonts-extra (~1 GB) is required: droidsans, fontawesome5 and marvosym live there.
missing=""
for f in memoir.cls droidsans.sty fontawesome5.sty marvosym.sty datetime.sty xifthen.sty ulem.sty babel.sty t2aenc.def pifont.sty; do
  kpsewhich "$f" >/dev/null 2>&1 || missing="$missing $f"
done
if [[ -z "$missing" ]]; then
  info "TeX: all CV class dependencies resolve (kpsewhich)"
else
  warn "TeX: missing packages:$missing  (pdflatex will fail on the CV; find them with: apt-file search <name>)"
fi

# ---------------------------------------------------------------- 2. Node 22
step "Node >= $NODE_MIN in /usr/local (side-by-side with Debian's $(/usr/bin/node --version 2>/dev/null || echo 'no /usr/bin/node'))"
node_ok() {
  local v
  v="$(/usr/local/bin/node --version 2>/dev/null | sed 's/^v//')" || return 1
  [[ -n "$v" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$NODE_MIN" "$v" | sort -V | head -1)" == "$NODE_MIN" ]]
}
if node_ok; then
  info "already present: /usr/local/bin/node $(/usr/local/bin/node --version)"
else
  info "downloading latest Node 22.x (linux-arm64) from nodejs.org"
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)"
  fname="$(printf '%s\n' "$sums" | grep -o 'node-v22\.[0-9.]*-linux-arm64\.tar\.xz' | head -1)"
  [[ -n "$fname" ]] || die "could not find a linux-arm64 tarball in latest-v22.x"
  curl -fsSL -o "$tmp/$fname" "https://nodejs.org/dist/latest-v22.x/$fname"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $fname\$" | sha256sum -c -)
  info "unpacking $fname into /usr/local (bin/node, bin/npm, lib/node_modules, include/node)"
  sudo tar -xJf "$tmp/$fname" -C /usr/local --strip-components=1 \
    --exclude='CHANGELOG.md' --exclude='LICENSE' --exclude='README.md'
  rm -rf "$tmp"
  node_ok || die "/usr/local/bin/node is still < $NODE_MIN"
  info "installed: /usr/local/bin/node $(/usr/local/bin/node --version)"
fi
info "/usr/bin/node stays $(/usr/bin/node --version 2>/dev/null || echo absent) for sb-webui"
# sb-webui must keep running on Debian's node. Its ExecStart uses the absolute /usr/bin/node (verified),
# but re-check here in case the unit changed.
if systemctl cat sb-webui >/dev/null 2>&1; then
  exec_line="$(systemctl show -p ExecStart --value sb-webui 2>/dev/null || true)"
  if [[ "$exec_line" == *"path=/usr/bin/node"* ]]; then
    info "sb-webui ExecStart uses /usr/bin/node explicitly: unaffected"
  else
    warn "sb-webui ExecStart does not pin /usr/bin/node; PATH now resolves 'node' to Node 22. Consider a drop-in:"
    warn "  sudo systemctl edit sb-webui  ->  [Service] ExecStart= / ExecStart=/usr/bin/node /opt/sb-webui/server.js"
  fi
  if [[ "$(systemctl is-active sb-webui)" == "active" ]]; then
    info "sb-webui is active"
  else
    warn "sb-webui is NOT active ($(systemctl is-active sb-webui || true)) - check it before continuing"
  fi
fi

# ---------------------------------------------------------------- 3. pnpm + claude
step "npm -g (Node 22): pnpm + @anthropic-ai/claude-code"
PNPM_VER="$(grep -o '"packageManager": *"pnpm@[0-9.]*"' "$DEPLOY_DIR/../package.json" 2>/dev/null | grep -o '[0-9][0-9.]*' || true)"
PNPM_VER="${PNPM_VER:-10}"
if [[ "$(/usr/local/bin/pnpm --version 2>/dev/null || true)" == "$PNPM_VER" ]]; then
  info "pnpm $PNPM_VER already installed"
else
  sudo /usr/local/bin/npm install -g --no-fund --no-audit "pnpm@$PNPM_VER"
fi
if command -v /usr/local/bin/claude >/dev/null 2>&1; then
  info "claude already installed: $(/usr/local/bin/claude --version 2>/dev/null | head -1 || true) (upgrade: sudo /usr/local/bin/npm i -g @anthropic-ai/claude-code)"
else
  sudo /usr/local/bin/npm install -g --no-fund --no-audit @anthropic-ai/claude-code
fi
info "pnpm $(/usr/local/bin/pnpm --version), claude $(/usr/local/bin/claude --version 2>/dev/null | head -1 || echo '?')"

# ---------------------------------------------------------------- 4. dirs
step "directories under $SGZ_ROOT owned by $ME"
sudo mkdir -p "$SGZ_ROOT"/{app,data,bin,backups}
sudo chown -R "$ME:$ME" "$SGZ_ROOT"
chmod 750 "$SGZ_ROOT/data"
cat > "$SGZ_ROOT/bin/sgz" <<'WRAP'
#!/usr/bin/env bash
# CLI wrapper with the same env as sgz.service. Usage: sgz run --user <slug> --source hh --limit 3
export SGZ_DATA_DIR=/opt/sgz/data SGZ_REPO_DIR=/opt/sgz/app NODE_ENV=production
export PATH=/usr/local/bin:/usr/bin:/bin
cd /opt/sgz/app || exit 1
exec /usr/local/bin/node packages/server/dist/cli.js "$@"
WRAP
chmod 755 "$SGZ_ROOT/bin/sgz"
sudo ln -sfn "$SGZ_ROOT/bin/sgz" /usr/local/bin/sgz
info "wrapper: /usr/local/bin/sgz -> $SGZ_ROOT/bin/sgz"

# ---------------------------------------------------------------- 5. systemd unit + journald
step "systemd: sgz.service (enabled, not started) + journald cap"
sudo install -m 644 "$DEPLOY_DIR/sgz.service" /etc/systemd/system/sgz.service
sudo mkdir -p /etc/systemd/journald.conf.d
if ! sudo cmp -s "$DEPLOY_DIR/journald-sgz.conf" /etc/systemd/journald.conf.d/sgz.conf 2>/dev/null; then
  sudo install -m 644 "$DEPLOY_DIR/journald-sgz.conf" /etc/systemd/journald.conf.d/sgz.conf
  sudo systemctl restart systemd-journald
  info "journald: SystemMaxUse cap installed"
fi
sudo systemctl daemon-reload
sudo systemctl enable sgz >/dev/null 2>&1
info "sgz.service: $(systemctl is-enabled sgz) / $(systemctl is-active sgz || true) (start happens in deploy.sh)"

# ---------------------------------------------------------------- 6. OOM protection
step "OOM protection for the gateway services (OOMScoreAdjust=-900)"
for u in sing-box pihole-FTL unbound; do
  if ! systemctl cat "$u" >/dev/null 2>&1; then
    warn "$u.service not found - skipped"
    continue
  fi
  sudo mkdir -p "/etc/systemd/system/$u.service.d"
  sudo install -m 644 "$DEPLOY_DIR/oom-protect/$u.conf" "/etc/systemd/system/$u.service.d/oom-protect.conf"
  # The drop-in applies on the next restart; adjust the running process now without restarting the gateway.
  pid="$(systemctl show -p MainPID --value "$u" 2>/dev/null || echo 0)"
  if [[ "${pid:-0}" -gt 0 ]]; then
    echo -900 | sudo tee "/proc/$pid/oom_score_adj" >/dev/null
    info "$u: drop-in installed, live oom_score_adj=$(cat "/proc/$pid/oom_score_adj") (pid $pid)"
  else
    info "$u: drop-in installed (not running)"
  fi
done
sudo systemctl daemon-reload

# ---------------------------------------------------------------- 7. nginx
step "nginx vhost $SGZ_HOST -> 127.0.0.1:3002"
if command -v nginx >/dev/null 2>&1; then
  sudo sed "s/server_name sgz.rp.i;/server_name $SGZ_HOST;/" "$DEPLOY_DIR/nginx-sgz.conf" | sudo tee /etc/nginx/sites-available/sgz.conf >/dev/null
  sudo ln -sfn /etc/nginx/sites-available/sgz.conf /etc/nginx/sites-enabled/sgz.conf
  if sudo nginx -t 2>&1 | tail -1; then
    sudo systemctl reload nginx
    info "nginx reloaded"
  else
    sudo rm -f /etc/nginx/sites-enabled/sgz.conf
    die "nginx -t failed; sgz vhost removed again"
  fi
else
  warn "nginx not installed - skipped"
fi

# ---------------------------------------------------------------- 8. Pi-hole DNS
LAN_IP="$(hostname -I | tr ' ' '\n' | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -1 || true)"
step "Pi-hole: local DNS record $SGZ_HOST -> ${LAN_IP:-?}"
if [[ -z "$LAN_IP" ]]; then
  warn "could not detect a private LAN IP from 'hostname -I' ($(hostname -I)); add the record by hand"
elif [[ -d /etc/pihole/hosts ]]; then
  # Pi-hole v6: every file in /etc/pihole/hosts/ is a hosts file for FTL. (The web UI writes the same
  # kind of record into pihole.toml dns.hosts; both are honoured.)
  hosts_file=/etc/pihole/hosts/custom.list
  sudo touch "$hosts_file"
  if sudo grep -qE "^[0-9a-fA-F.:]+[[:space:]]+$SGZ_HOST(\$|[[:space:]])" "$hosts_file"; then
    sudo sed -i -E "s/^[0-9a-fA-F.:]+([[:space:]]+$SGZ_HOST)(\$|[[:space:]].*)/$LAN_IP\1\2/" "$hosts_file"
  else
    echo "$LAN_IP $SGZ_HOST" | sudo tee -a "$hosts_file" >/dev/null
  fi
  sudo pihole reloaddns >/dev/null 2>&1 || sudo pihole restartdns >/dev/null 2>&1 || warn "pihole reloaddns failed; run it by hand"
  info "$(sudo grep "$SGZ_HOST" "$hosts_file") (in $hosts_file)"
elif [[ -f /etc/pihole/custom.list ]]; then
  # Pi-hole v5 fallback.
  sudo sed -i -E "/[[:space:]]$SGZ_HOST\$/d" /etc/pihole/custom.list
  echo "$LAN_IP $SGZ_HOST" | sudo tee -a /etc/pihole/custom.list >/dev/null
  sudo pihole restartdns reload-lists >/dev/null 2>&1 || true
  info "added to /etc/pihole/custom.list (v5 style)"
else
  warn "Pi-hole not found; add '$LAN_IP $SGZ_HOST' to your DNS by hand"
fi
resolved="$(getent hosts "$SGZ_HOST" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [[ "$resolved" == "$LAN_IP" ]]; then
  info "$SGZ_HOST resolves to $resolved"
else
  warn "$SGZ_HOST resolves to '${resolved:-nothing}' from this box (expected $LAN_IP) - may take a moment, or this box does not use Pi-hole as resolver"
fi

# ---------------------------------------------------------------- 9. smoke checks
step "smoke: chromium headless"
if timeout 60 chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom about:blank 2>/dev/null | grep -q '<html'; then
  info "chromium headless renders about:blank"
else
  warn "chromium headless smoke test failed (run: chromium --headless=new --no-sandbox --dump-dom about:blank)"
fi

step "smoke: egress (the runner must look like a Russian home connection to hh.ru)"
code="$(curl -sL -m 15 -o /dev/null -w '%{http_code}' https://hh.ru/ || echo 000)"
if [[ "$code" == "200" ]]; then
  info "https://hh.ru/ -> 200"
else
  warn "https://hh.ru/ -> $code (expected 200). Check sing-box routing / DNS before running the bot."
fi
egress_ip=""
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com https://ipinfo.io/ip; do
  egress_ip="$(curl -s -m 10 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$egress_ip" =~ ^[0-9.]+$ ]] && break
  egress_ip=""
done
if [[ -z "$egress_ip" ]]; then
  warn "could not determine the egress IP (all IP echo services failed)"
else
  country="$(curl -s -m 10 "http://ip-api.com/line/$egress_ip?fields=countryCode" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$country" ]] || country="$(curl -s -m 10 "https://ipapi.co/$egress_ip/country/" 2>/dev/null | tr -d '[:space:]' || true)"
  info "egress IP: $egress_ip  country: ${country:-unknown}"
  if [[ "${country:-}" != "RU" ]]; then
    warn "egress is not Russian (${country:-unknown}). hh.ru will captcha/ban foreign IPs."
    warn "Make sure sing-box does NOT proxy this box's own traffic to hh.ru (rule for uid $(id -u) / cgroup sgz.service, or a direct route for *.hh.ru)."
  fi
fi

# ---------------------------------------------------------------- 10. next steps
step "done. Next steps"
cat <<NEXT
  1. Log the Claude Code CLI in ONCE as $ME (subscription login, opens a URL to paste a code back):
        ssh -t rpi-ts claude            # then /login, or just follow the prompt; verify with:  claude -p 'reply with ok'
  2. On the Mac: log into hh.ru per user and ship data + app:
        pnpm sgz hh-login --user <slug>
        make sync-data                  # data/ -> $SGZ_ROOT/data (strips SGZ_DATA_DIR, pins Pi binaries in .env)
        make deploy                     # build, rsync, pnpm install --prod, systemctl restart sgz
  3. First supervised run on the Pi while watching memory:
        ssh rpi-ts                       ->  sgz run --user <slug> --source hh --dry-run --limit 3
        ssh rpi-ts 'watch -n2 free -m'   and  ssh rpi-ts 'journalctl -fu sgz'
  4. Panel: http://$SGZ_HOST (LAN via Pi-hole DNS) or http://$(ip -4 -o addr show tailscale0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || echo '<tailscale-ip>'):3002 (Tailscale).
  Docs: docs/DEPLOY.md, docs/RUNBOOK.md in the repo.
NEXT
