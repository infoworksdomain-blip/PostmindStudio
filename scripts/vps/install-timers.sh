#!/usr/bin/env bash
# Deployment: single VPS. Installs the systemd timers for one environment (run once with sudo, and
# again after pulling a change to this file):
#   postmind-backup@<env>.timer       daily 02:30 UTC  scripts/vps/backup.sh <env>  (db + storage)
#   postmind-healthcheck@<env>.timer  every 5 minutes  scripts/vps/healthcheck.sh <env>
# Persistent=true runs a backup that was missed while the server was off at the next boot.
# Logs: journalctl -u postmind-backup@<env> / -u postmind-healthcheck@<env>.
#
#   sudo scripts/vps/install-timers.sh production [deploy-user]
#   sudo scripts/vps/install-timers.sh staging --remove      # when staging is switched off
set -euo pipefail

[ "$(id -u)" -eq 0 ] || {
  echo "run with sudo" >&2
  exit 1
}
env_name="${1:-}"
case "$env_name" in production | staging) ;; *) echo "usage: install-timers.sh <production|staging> [user|--remove]" >&2 && exit 64 ;; esac
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unit_dir=/etc/systemd/system

if [ "${2:-}" = "--remove" ]; then
  systemctl disable --now "postmind-backup@${env_name}.timer" "postmind-healthcheck@${env_name}.timer" || true
  echo "timers for ${env_name} removed"
  exit 0
fi
run_as="${2:-deploy}"
id "$run_as" >/dev/null

cat >"$unit_dir/postmind-backup@.service" <<EOF
[Unit]
Description=PostMind Studio backups (%i)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=${run_as}
ExecStart=/usr/bin/bash ${repo_dir}/scripts/vps/backup.sh %i all
TimeoutStartSec=6h
EOF

cat >"$unit_dir/postmind-backup@.timer" <<'EOF'
[Unit]
Description=Nightly PostMind Studio backups (%i)

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

cat >"$unit_dir/postmind-healthcheck@.service" <<EOF
[Unit]
Description=PostMind Studio health check (%i)
After=docker.service

[Service]
Type=oneshot
User=${run_as}
ExecStart=/usr/bin/bash ${repo_dir}/scripts/vps/healthcheck.sh %i
TimeoutStartSec=2min
EOF

cat >"$unit_dir/postmind-healthcheck@.timer" <<'EOF'
[Unit]
Description=PostMind Studio health check every 5 minutes (%i)

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "postmind-backup@${env_name}.timer" "postmind-healthcheck@${env_name}.timer"
systemctl list-timers "postmind-*@${env_name}.timer" --no-pager
