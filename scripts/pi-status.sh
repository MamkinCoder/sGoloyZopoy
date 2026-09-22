#!/usr/bin/env bash
# Quick health view of the Pi: memory, service, recent logs, HTTP health. Usage: scripts/pi-status.sh [journal lines]
set -euo pipefail
PI_HOST="${PI_HOST:-rpi-ts}"
LINES="${1:-30}"
ssh "$PI_HOST" "
  echo '== free -m'; free -m
  echo; echo '== gateway services'; for u in sing-box pihole-FTL unbound nginx; do printf '%-12s %s\n' \$u \$(systemctl is-active \$u); done
  echo; echo '== sgz.service'; systemctl status sgz --no-pager -n 0 2>&1 | head -12
  echo; echo '== cgroup memory'; cat /sys/fs/cgroup/system.slice/sgz.service/memory.current 2>/dev/null | awk '{printf \"sgz.service memory.current: %.0f MB\n\", \$1/1048576}' || echo 'n/a (not running)'
  systemd-cgtop -b -n 1 -m 8 2>/dev/null | head -10 || true
  echo; echo '== health'; code=\$(curl -s -m 5 -o /tmp/sgz-health.json -w '%{http_code}' http://127.0.0.1:3002/api/health || echo 000); echo \"GET /api/health -> \$code\"; head -c 600 /tmp/sgz-health.json 2>/dev/null; echo; rm -f /tmp/sgz-health.json
  echo; echo '== release'; cat /opt/sgz/app/RELEASE 2>/dev/null || echo 'no RELEASE file'
  echo; echo '== journalctl -u sgz -n $LINES'; journalctl -u sgz -n $LINES --no-pager
"
