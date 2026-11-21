#!/usr/bin/env bash
# Runs on pre-provisioned Puzzle Duel staging deploy account; no sudo or DB changes.
set -euo pipefail
sha="${1:?commit sha required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit SHA" >&2; exit 2; }
base="$HOME/pzd-staging"
releases="$base/releases"
current="$base/current"
archive="$HOME/pzd-staging-release.tgz"
[[ -d "$base" && -d "$releases" && -f "$archive" ]] || { echo "PZD staging host not provisioned" >&2; exit 3; }
[[ ! -L "$base" ]] || { echo "staging base must not be symlink" >&2; exit 3; }
[[ -f "$base/APPROVED_FOR_CD" ]] || { echo "owner staging CD gate missing" >&2; exit 3; }
previous="$(readlink "$current" || true)"
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
command -v node >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 26) process.exit(1)'
npm ci --omit=dev --ignore-scripts
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$current"
# Dedicated pre-provisioned user service. No privileged systemctl, Forest Dash or Caddy mutations.
if ! systemctl --user restart pzd-staging.service; then
  echo "staging service restart failed" >&2
  if [[ -n "$previous" && "$previous" == "$releases/"* ]]; then
    ln -sfn "$previous" "$base/current.next"
    mv -Tf "$base/current.next" "$current"
    systemctl --user restart pzd-staging.service || true
  fi
  exit 5
fi
# Must be a dedicated loopback-only health endpoint implemented by the staging runtime.
if ! curl --fail --silent --show-error --max-time 5 --retry 5 --retry-delay 2 http://127.0.0.1:8787/healthz >/dev/null; then
  echo "staging health check failed; rolling back application release" >&2
  if [[ -n "$previous" && "$previous" == "$releases/"* ]]; then
    ln -sfn "$previous" "$base/current.next"
    mv -Tf "$base/current.next" "$current"
    systemctl --user restart pzd-staging.service || true
  else
    systemctl --user stop pzd-staging.service || true
  fi
  exit 6
fi
echo "PZD staging deployment healthy: $sha"
