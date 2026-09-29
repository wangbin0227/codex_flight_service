#!/usr/bin/env bash
# Install service definitions only. Never installs packages, starts jobs or replaces secrets.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || fail 'Run this installer as root on Linux with systemd.'
[[ -d /run/systemd/system ]] || fail 'A running systemd is required (Ubuntu 24.04 / Debian 12 recommended).'
command -v systemctl >/dev/null || fail 'systemctl is required.'
[[ $(systemctl --version | head -n 1 | awk '{print $2}') -ge 252 ]] || fail 'systemd 252+ is required.'

flight_app_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
flight_node_bin=${FLIGHT_NODE_BIN:-$(command -v node || true)}
[[ -n $flight_node_bin && -x $flight_node_bin ]] || fail 'Install a system-wide Node.js 24+ first; alternatively set FLIGHT_NODE_BIN to its absolute path.'
flight_node_bin=$(readlink -f -- "$flight_node_bin")
for flight_path in "$flight_app_dir" "$flight_node_bin"; do
  [[ $flight_path =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Application / Node paths must be absolute and contain only ASCII letters, digits, _, ., / and -.'
  case "$flight_path" in /root|/root/*|/home|/home/*|/tmp|/tmp/*) fail 'Install code and Node outside /home, /root and /tmp; use /opt/codex-flight-service and a system-wide Node.' ;; esac
done
flight_node_dir=$(dirname -- "$flight_node_bin")
"$flight_node_bin" -e 'const major=Number(process.versions.node.split(".")[0]); if(major<24||major>26)process.exit(1)' || fail 'Node.js 24–26 is required; Node 24 LTS is recommended.'
[[ $(stat -c '%u' "$flight_app_dir") == 0 ]] || fail 'The application directory must be owned by root; clone into /opt with sudo.'
[[ -f "$flight_app_dir/dist/src/main.js" && -f "$flight_app_dir/dist/src/worker-main.js" ]] || fail 'Build first: npm ci && npm run build.'
[[ -x "$flight_app_dir/node_modules/.bin/codex" ]] || fail 'Project dependencies are missing. Run npm ci; do not copy macOS node_modules to Linux.'

if ! id codex-flight >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/codex-flight-service --shell /usr/sbin/nologin codex-flight
else
  [[ $(id -u codex-flight) -ne 0 ]] || fail 'Refusing a root service identity.'
  [[ $(getent passwd codex-flight | cut -d: -f6) == /var/lib/codex-flight-service ]] || fail 'An unrelated codex-flight user already exists; resolve the account conflict first.'
fi
install -d -m 0700 -o codex-flight -g codex-flight /var/lib/codex-flight-service
install -d -m 0700 -o root -g root /etc/codex-flight-service

for flight_role in api worker; do
  flight_env=/etc/codex-flight-service/$flight_role.env
  if [[ ! -e $flight_env ]]; then
    install -m 0600 -o root -g root "$flight_app_dir/deploy/native/$flight_role.env.example" "$flight_env"
  fi
done
"$flight_node_bin" --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
for (const [name, value] of [
  ['service-api-keys.json', JSON.stringify({ miaoda: randomBytes(32).toString('hex') }, null, 2) + '\n'],
  ['model-api-key.txt', ''],
]) {
  try { writeFileSync('/etc/codex-flight-service/' + name, value, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
JS
for flight_role in api worker; do
  sed -e "s|@APP_DIR@|$flight_app_dir|g" -e "s|@NODE_BIN@|$flight_node_bin|g" -e "s|@NODE_DIR@|$flight_node_dir|g" \
    "$flight_app_dir/deploy/native/codex-flight-$flight_role.service" > "/etc/systemd/system/codex-flight-$flight_role.service"
  chmod 0644 "/etc/systemd/system/codex-flight-$flight_role.service"
done
systemd-analyze verify /etc/systemd/system/codex-flight-api.service /etc/systemd/system/codex-flight-worker.service
systemctl daemon-reload
printf '%s\n' 'Installed systemd units. Existing configuration and secrets were preserved.' \
  'Edit /etc/codex-flight-service/model-api-key.txt and worker.env, then run:' \
  '  systemctl enable --now codex-flight-api codex-flight-worker' \
  'Read docs/deployment-native.md for browser installation, HTTPS, smoke checks and backup.'
