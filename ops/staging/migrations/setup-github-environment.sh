#!/usr/bin/env bash
# Run on the operator's Mac with a GitHub CLI account that has repository admin rights.
# It does NOT access Oracle or migrate any database. Never pass passwords here.
set -euo pipefail
umask 077

repo="puzzle-duel/puzzle-duel-backend"
environment="pzd-staging-migrations"
reviewer="${1:-}"
key="${2:-$HOME/.ssh/pzd-staging-migrations}"
host="84.13.66.211"
user="pzd-staging"

fail() { printf 'BLOCKED: %s\n' "$1" >&2; exit 1; }
[[ "$reviewer" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$ ]] ||
  fail "Usage: bash setup-github-environment.sh OTHER_REVIEWER_GITHUB_LOGIN [PRIVATE_KEY_PATH]"
command -v gh >/dev/null || fail "GitHub CLI required (gh auth login)"
command -v ssh-keygen >/dev/null || fail "ssh-keygen required"
gh auth status >/dev/null 2>&1 || fail "GitHub CLI authentication missing"
myself="$(gh api user --jq '.login')" || fail "GitHub account lookup failed"
[[ "${reviewer,,}" != "${myself,,}" ]] || fail "Reviewer must be someone other than the operator"
my_permission="$(gh api "repos/$repo" --jq '.permissions.admin')" || fail "Repository permission lookup failed"
[[ "$my_permission" == true ]] || fail "Admin access required to manage deployment environments"
reviewer_id="$(gh api "users/$reviewer" --jq '.id')" || fail "Reviewer lookup failed"
[[ "$reviewer_id" =~ ^[1-9][0-9]*$ ]] || fail "Reviewer account ID invalid"
permission="$(gh api "repos/$repo/collaborators/$reviewer/permission" --jq '.permission')" ||
  fail "Reviewer must have repository access"
[[ "$permission" != none ]] || fail "Reviewer has no repository permission"

if gh api "repos/$repo/environments/$environment" >/dev/null 2>&1; then
  fail "Environment already exists; inspect it instead of silently overwriting protection rules"
fi

# Fail-closed: GitHub REST API rejects unsupported protection rules.
gh api --method PUT "repos/$repo/environments/$environment" --input - >/dev/null <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": true,
  "reviewers": [{"type":"User","id":$reviewer_id}],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON
gh api --method POST "repos/$repo/environments/$environment/deployment-branch-policies" \
  -f name="version/0.0.2" >/dev/null

gh api "repos/$repo/environments/$environment" \
  --jq '.protection_rules[].type' | grep -qx required_reviewers ||
  fail "Required reviewer protection was not confirmed"
gh api "repos/$repo/environments/$environment/deployment-branch-policies" \
  --jq '.branch_policies[].name' | grep -Fxq "version/0.0.2" ||
  fail "Exact release branch restriction was not confirmed"
gh api "repos/$repo/environments/$environment" --jq '.deployment_branch_policy.custom_branch_policies' |
  grep -Fxq true || fail "Custom branch restriction is not enabled"
gh api "repos/$repo/environments/$environment" --jq '.protection_rules[] | select(.type == "required_reviewers") | .prevent_self_review' |
  grep -Fxq true || fail "Self-review prevention is not enabled"

# Distinct SSH key from normal staging deployment. Do not overwrite any existing key.
if [[ ! -f "$key" || ! -f "$key.pub" ]]; then
  [[ ! -e "$key" && ! -e "$key.pub" ]] || fail "Partial SSH key exists: inspect it manually"
  ssh-keygen -q -t ed25519 -f "$key" -N '' -C 'pzd-staging-migrations-gha'
fi
[[ "$(stat -f '%Lp' "$key")" == 600 ]] ||
  fail "SSH private key must be mode 0600"
# Host key must be already verified by an operator (never trust a fresh scan blindly).
known="$HOME/.ssh/known_hosts"
[[ -f "$known" ]] || fail "No existing pinned known_hosts entry"
host_record="$(ssh-keygen -F "$host" -f "$known" | grep -v '^#' || true)"
[[ -n "$host_record" ]] || fail "Pin and verify Oracle host key before storing any GitHub secrets"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$host_record" > "$tmp"
chmod 600 "$tmp"

gh secret set PZD_MIGRATION_HOST -R "$repo" -e "$environment" --body "$host"
gh secret set PZD_MIGRATION_USER -R "$repo" -e "$environment" --body "$user"
gh secret set PZD_MIGRATION_SSH_PRIVATE_KEY -R "$repo" -e "$environment" < "$key"
gh secret set PZD_MIGRATION_SSH_KNOWN_HOSTS -R "$repo" -e "$environment" < "$tmp"

echo "GitHub protected environment configured and verified."
echo "STOP: Key must STILL be authorized on Oracle before plan can succeed."
echo "Public key to install (NOT private key): $key.pub"
echo "Do not run apply until PostgreSQL roles and private service config are provisioned."
