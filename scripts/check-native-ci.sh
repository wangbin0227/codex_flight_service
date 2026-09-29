#!/usr/bin/env bash
# Integration check for a disposable GitHub Linux runner; not a production installer.
set -euo pipefail
[[ ${CI:-} == true && $EUID -eq 0 && -d /run/systemd/system ]] || { printf '%s\n' 'CI-only check; requires root and systemd.' >&2; exit 1; }
[[ ! -e /opt/codex-flight-service && ! -e /etc/codex-flight-service ]] || { printf '%s\n' 'Refusing to overwrite an existing installation.' >&2; exit 1; }
flight_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
flight_node=${FLIGHT_NODE_BIN:?Pass the tested Node binary in FLIGHT_NODE_BIN}
flight_app=/opt/codex-flight-service
install -d -m 0755 "$flight_app"
cp -a "$flight_repo/dist" "$flight_repo/node_modules" "$flight_repo/package.json" "$flight_repo/deploy" "$flight_repo/scripts" "$flight_app/"
chown -R root:root "$flight_app"
env PLAYWRIGHT_BROWSERS_PATH="$flight_app/browsers" "$flight_node" "$flight_app/node_modules/playwright/cli.js" install --with-deps chromium --only-shell
bash "$flight_app/scripts/install-native.sh"
trap 'systemctl stop codex-flight-api codex-flight-worker 2>/dev/null || true' EXIT

# Fixture credentials never call a model; the only submitted item is invalid.
printf '%s\n' 'ci-fixture-no-model-calls' > /etc/codex-flight-service/model-api-key.txt
printf '%s\n' '# CI preservation check' >> /etc/codex-flight-service/api.env
flight_before=$(sha256sum /etc/codex-flight-service/* | sha256sum)
bash "$flight_app/scripts/install-native.sh"
flight_after=$(sha256sum /etc/codex-flight-service/* | sha256sum)
[[ $flight_before == "$flight_after" ]]

# Exercise Chromium and the pinned Codex binary inside the actual Worker sandbox.
install -d /run/systemd/system/codex-flight-worker.service.d
cat > /run/systemd/system/codex-flight-worker.service.d/ci-doctor.conf <<EOF
[Service]
Type=oneshot
ExecStart=
ExecStart=$flight_node dist/scripts/doctor.js
ExecStart=$flight_node dist/scripts/check-captcha.js
Restart=no
TimeoutStartSec=90
EOF
systemctl daemon-reload
systemctl start codex-flight-worker
journalctl -u codex-flight-worker --no-pager -o cat | grep -F '"browser": "started"'
journalctl -u codex-flight-worker --no-pager -o cat | grep -F 'CAPTCHA browser fixtures passed'
rm /run/systemd/system/codex-flight-worker.service.d/ci-doctor.conf
systemctl daemon-reload
systemctl start codex-flight-api codex-flight-worker

"$flight_node" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const key = Object.values(JSON.parse(readFileSync('/etc/codex-flight-service/service-api-keys.json', 'utf8')))[0];
const headers = { Authorization: `Bearer ${key}`, 'X-User-Id': 'native-ci', 'Content-Type': 'application/json', 'Idempotency-Key': 'native-ci-batch' };
let ready = false;
for (let i = 0; i < 40; i++) {
  try { const res = await fetch('http://127.0.0.1:8080/readyz', { headers, signal: AbortSignal.timeout(2000) }); if (res.ok) { ready = true; break; } } catch {}
  await setTimeout(500);
}
assert.equal(ready, true, 'API and Worker should become ready');
const response = await fetch('http://127.0.0.1:8080/v1/batches', { method: 'POST', headers, body: JSON.stringify({ mawbs: ['invalid'] }) });
assert.equal(response.status, 202);
const batch = await response.json();
assert.equal(batch.jobs[0].status, 'invalid_input');
assert.equal(batch.jobs[0].attempt, 0);
console.log('Native systemd API/Worker, browser startup, credentials and config preservation: passed. No model calls.');
JS
