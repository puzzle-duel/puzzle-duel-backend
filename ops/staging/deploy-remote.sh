#!/usr/bin/env bash
# Runs as the isolated pzd-staging deploy account. Requires narrowly scoped passwordless sudo ONLY for pzd-staging.service restart/stop; never touches other services.
set -euo pipefail
sha="${1:?commit sha required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit SHA" >&2; exit 2; }
base="/home/pzd-staging/pzd-staging"
releases="$base/releases"
current="$base/current"
archive="/home/pzd-staging/pzd-staging-release.tgz"
[[ -d "$base" && -d "$releases" && -f "$archive" ]] || { echo "PZD staging host not provisioned" >&2; exit 3; }
[[ ! -L "$base" ]] || { echo "staging base must not be symlink" >&2; exit 3; }
previous="$(readlink -f "$current" || true)"
release="$releases/$sha"
if [[ -e "$release" ]]; then
  echo "release already exists; refusing to overwrite" >&2
  exit 4
fi
mkdir "$release"
cleanup() { rm -f "$archive"; }
trap cleanup EXIT
tar -xzf "$archive" -C "$release" --no-same-owner --no-same-permissions
cd "$release"
test -x /opt/pzd-node26/bin/node
/opt/pzd-node26/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 26) process.exit(1)'
/opt/pzd-node26/bin/node /opt/pzd-node26/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$current"
# Dedicated pre-provisioned user service. No privileged systemctl, Forest Dash or Caddy mutations.
if ! sudo -n /usr/bin/systemctl restart pzd-staging.service; then
  echo "staging service restart failed" >&2
  if [[ -n "$previous" && -d "$previous" && "$previous" == "$releases/"* ]]; then
    ln -sfn "$previous" "$base/current.next"
    mv -Tf "$base/current.next" "$current"
    sudo -n /usr/bin/systemctl restart pzd-staging.service || true
  fi
  exit 5
fi
# Must be a dedicated loopback-only health endpoint implemented by the staging runtime.
# Node may need a few seconds after systemd reports the restart successful.
# Retry connection-refused as well as HTTP 5xx before declaring the release unhealthy.
if ! curl --fail --silent --show-error --max-time 5 --retry 12 --retry-delay 2 --retry-connrefused http://127.0.0.1:8787/healthz >/dev/null; then
  echo "staging health check failed; rolling back application release" >&2
  if [[ -n "$previous" && "$previous" == "$releases/"* ]]; then
    ln -sfn "$previous" "$base/current.next"
    mv -Tf "$base/current.next" "$current"
    sudo -n /usr/bin/systemctl restart pzd-staging.service || true
  else
    sudo -n /usr/bin/systemctl stop pzd-staging.service || true
  fi
  exit 6
fi
echo "PZD staging deployment healthy: $sha"
