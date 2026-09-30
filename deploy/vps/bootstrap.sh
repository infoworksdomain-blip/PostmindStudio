#!/usr/bin/env bash
# PostMind Studio — one-time server setup for a fresh Hetzner Cloud server running Ubuntu 24.04 or 26.04
# (runbooks/vps-deploy.md step 4). Run as root, once; running it again is safe (idempotent).
# Contains no secrets.
#
#   scp deploy/vps/bootstrap.sh root@<ip>:/root/
#   ssh root@<ip> 'bash /root/bootstrap.sh'                      # deploy user "deploy", 2G swap
#   ssh root@<ip> 'DEPLOY_USER=ops SWAP_SIZE=4G bash /root/bootstrap.sh'
#
# What it does:
#   1. updates packages; installs curl, git, ufw, fail2ban, unattended-upgrades
#   2. creates the deploy user with the SSH key(s) root was created with, passwordless sudo
#   3. SSH: key-only, no root login, no passwords (a drop-in that wins over cloud-init's)
#   4. UFW: deny incoming except 22 (rate-limited), 80, 443 tcp, 443 udp (HTTP/3)
#   5. fail2ban sshd jail; automatic security updates (unattended-upgrades)
#   6. Docker Engine + compose plugin from Docker's apt repository
#   7. swap file, vm.swappiness, vm.overcommit_memory for Valkey; timezone UTC
#   8. /etc/postmind-studio, /var/lib/postmind-studio, /opt/postmind-studio owned by the deploy user
# Sources (read 2026-09-29) are cited next to each step.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAPFILE=/swapfile
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
# shellcheck disable=SC1091 # the OS release file only exists on the server
. /etc/os-release
# Ubuntu LTS releases this script is checked against. 26.04 (resolute): Docker publishes a
# resolute suite (https://download.docker.com/linux/ubuntu/dists/resolute/), OpenSSH still reads
# sshd_config.d first and the unit is still ssh.service, and fail2ban 1.1.0 depends on
# python3-systemd, which the systemd backend below needs (all checked on a Hetzner 26.04 server,
# 2026-09-30).
case "${ID:-}/${VERSION_ID:-}" in
  ubuntu/24.04 | ubuntu/26.04) ;;
  *) fail "expected Ubuntu 24.04 or 26.04, found ${PRETTY_NAME:-unknown}" ;;
esac
[[ "$DEPLOY_USER" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || fail "DEPLOY_USER is not a valid user name"
[[ "$SWAP_SIZE" =~ ^[0-9]+[MG]$ ]] || fail "SWAP_SIZE must look like 2G or 2048M"

packages() {
  say "packages"
  apt-get update -qq
  apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
  apt-get install -y -qq ca-certificates curl git ufw fail2ban unattended-upgrades
}

deploy_user() {
  say "deploy user $DEPLOY_USER"
  id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
  install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  local keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
  touch "$keys"
  # Hetzner puts the SSH key chosen at server creation into root's authorized_keys.
  if [ -s /root/.ssh/authorized_keys ]; then
    while IFS= read -r key; do
      [ -z "$key" ] || grep -qxF "$key" "$keys" || printf '%s\n' "$key" >>"$keys"
    done </root/.ssh/authorized_keys
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$keys" && chmod 0600 "$keys"
  grep -qE '^(ssh-|ecdsa-|sk-)' "$keys" ||
    fail "no SSH public key for $DEPLOY_USER: create the server with your SSH key (runbooks/vps-deploy.md step 2)"
  # No password exists for this user, so sudo cannot ask for one. Docker group membership is
  # root-equivalent anyway: "The docker group grants root-level privileges to the user"
  # (https://docs.docker.com/engine/install/linux-postinstall/).
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" >"/etc/sudoers.d/90-$DEPLOY_USER"
  chmod 0440 "/etc/sudoers.d/90-$DEPLOY_USER"
  visudo -cf "/etc/sudoers.d/90-$DEPLOY_USER" >/dev/null
}

ssh_hardening() {
  say "SSH: keys only, no root login"
  # Ubuntu's sshd_config includes /etc/ssh/sshd_config.d/*.conf first and "OpenSSH uses the first
  # value set for most directives" (https://ubuntu.com/server/docs/how-to/security/openssh-server/),
  # so a file sorting before cloud-init's 50-cloud-init.conf wins.
  cat >/etc/ssh/sshd_config.d/01-postmind-hardening.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $DEPLOY_USER
EOF
  sshd -t || fail "sshd config test failed; not restarting ssh"
  # Same page: validate with sshd -t, then restart ssh.service. Open sessions stay connected.
  systemctl restart ssh.service
}

firewall() {
  say "UFW (the Hetzner Cloud Firewall in front is the primary filter)"
  # Syntax from ufw(8) (https://manpages.ubuntu.com/manpages/noble/en/man8/ufw.8.html): `limit`
  # denies an address that opens 6 or more connections in 30 seconds; `--force enable` skips the
  # prompt ufw shows over SSH. Docker-published ports bypass UFW
  # (https://docs.docker.com/engine/network/packet-filtering-firewalls/), which is why the stack
  # publishes only 80/443 (Caddy) and 127.0.0.1-bound ports.
  ufw default deny incoming
  ufw default allow outgoing
  ufw limit 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
}

fail2ban_and_updates() {
  say "fail2ban + unattended-upgrades"
  # This file enables the sshd jail itself (26.04 included). Ubuntu 24.04's fail2ban package also enables the sshd jail with backend=systemd
  # (debian/debian-files/jail.d_defaults-debian.conf, noble-updates); this file only makes bans
  # longer. Launchpad bug 2055114 broke fail2ban on 24.04 until 1.0.2-3ubuntu0.1: the upgrade above
  # installs the fixed package.
  cat >/etc/fail2ban/jail.d/postmind-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban
  # https://documentation.ubuntu.com/server/how-to/software/automatic-updates/: these two lines
  # (in days) turn on the daily package-list update and unattended security upgrades.
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades
}

docker_engine() {
  say "Docker Engine from Docker's apt repository"
  # Exactly the steps of https://docs.docker.com/engine/install/ubuntu/ (page dated 2026-08-10).
  local pkg
  for pkg in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then apt-get remove -y -qq "$pkg"; fi
  done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  usermod -aG docker "$DEPLOY_USER"
  docker compose version
}

swap_and_time() {
  say "swap ($SWAP_SIZE), sysctl, timezone"
  # https://help.ubuntu.com/community/SwapFaq: fallocate, chmod 600, mkswap, swapon, fstab line.
  if ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
    [ -f "$SWAPFILE" ] || fallocate -l "$SWAP_SIZE" "$SWAPFILE"
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
    swapon "$SWAPFILE"
  fi
  grep -qE "^${SWAPFILE}[[:space:]]" /etc/fstab || printf '%s swap swap defaults 0 0\n' "$SWAPFILE" >>/etc/fstab
  # Swap only under pressure. "Set the Linux kernel overcommit memory setting to 1" so Valkey's
  # background save can fork (https://valkey.io/topics/admin/). Each container has a memory limit,
  # so a runaway process is stopped inside its own cgroup first.
  cat >/etc/sysctl.d/90-postmind.conf <<'EOF'
vm.swappiness = 10
vm.overcommit_memory = 1
EOF
  sysctl --system >/dev/null
  timedatectl set-timezone UTC
}

directories() {
  say "directories"
  install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /etc/postmind-studio /etc/postmind-studio/secrets
  install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /var/lib/postmind-studio /opt/postmind-studio
}

packages
deploy_user
firewall
fail2ban_and_updates
docker_engine
swap_and_time
directories
ssh_hardening

say "done"
cat <<EOF
Next (runbooks/vps-deploy.md step 5): log in as ${DEPLOY_USER} — root login is now off:
  ssh ${DEPLOY_USER}@<server ip>
Check: 'ufw status verbose', 'swapon --show', 'docker compose version', 'fail2ban-client status sshd'.
A kernel update needs a reboot: 'sudo reboot' at a quiet time (automatic reboots are off).
EOF
