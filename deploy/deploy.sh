#!/usr/bin/env bash
# Deploy tlcmap-mcp: ./deploy.sh <git-ref>   or   ./deploy.sh --rollback
# Must run as root. Releases live in /opt/tlcmap-mcp/releases/<sha>; `current` points at one.
set -euo pipefail

REPO="git@github.com:Systemik-Solutions/tlcmap-mcp.git"
BASE="/opt/tlcmap-mcp"
RELEASES="${BASE}/releases"
CURRENT="${BASE}/current"
ENV_FILE="/etc/tlcmap-mcp/env"
SERVICE="tlcmap-mcp"
RUN_USER="tlcmap-mcp"
KEEP=3
WAIT_SECONDS=30

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./deploy.sh <git-ref>)"
[ $# -eq 1 ] || die "usage: deploy.sh <git-ref> | --rollback"

# Read PORT from the env file without executing its content.
PORT=3100
if [ -r "${ENV_FILE}" ]; then
  file_port="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true)"
  if [ -n "${file_port}" ]; then PORT="${file_port}"; fi
fi

current_target() { readlink -f "${CURRENT}" 2>/dev/null || true; }

release_version() { node -p "require('$1/package.json').version"; }

# Poll /healthz for up to WAIT_SECONDS until it reports the expected version.
wait_healthy() {
  local expected="$1" body live i
  for ((i = 1; i <= WAIT_SECONDS; i++)); do
    body="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
    if [ -n "${body}" ]; then
      live="$(printf '%s' "${body}" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" 2>/dev/null || true)"
      if [ "${live}" = "${expected}" ]; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

prune() {
  local keep_target dir count=0
  keep_target="$(current_target)"
  while IFS= read -r dir; do
    count=$((count + 1))
    if [ "${count}" -le "${KEEP}" ]; then continue; fi
    if [ "$(readlink -f "${dir}")" = "${keep_target}" ]; then continue; fi
    log "Pruning ${dir}"
    rm -rf -- "${dir}"
  done < <(find "${RELEASES}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

if [ "$1" = "--rollback" ]; then
  now="$(current_target)"
  [ -n "${now}" ] || die "no current release"
  previous=""
  while IFS= read -r dir; do
    if [ "$(readlink -f "${dir}")" != "${now}" ]; then previous="${dir}"; break; fi
  done < <(find "${RELEASES}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  [ -n "${previous}" ] || die "no previous release to roll back to"
  log "Rolling back ${now} -> ${previous}"
  ln -sfn "${previous}" "${CURRENT}"
  systemctl restart "${SERVICE}"
  if wait_healthy "$(release_version "${previous}")"; then
    log "Rollback healthy"
    exit 0
  fi
  die "rolled-back release did not become healthy; check: journalctl -u ${SERVICE}"
fi

REF="$1"
mkdir -p "${RELEASES}"
staging="$(mktemp -d "${RELEASES}/.clone.XXXXXX")"
trap 'rm -rf -- "${staging}"' EXIT

log "Cloning ${REPO} at ${REF}"
git clone --quiet "${REPO}" "${staging}"
git -C "${staging}" checkout --quiet "${REF}"
sha="$(git -C "${staging}" rev-parse --short=12 HEAD)"
release="${RELEASES}/${sha}"

if [ -e "${release}" ]; then
  log "Release ${sha} already exists; replacing it"
  [ "$(readlink -f "${release}")" != "$(current_target)" ] || die "release ${sha} is the running release; deploy a different ref or roll back"
  rm -rf -- "${release}"
fi
mv "${staging}" "${release}"
trap - EXIT
chown -R "${RUN_USER}:${RUN_USER}" "${release}"

log "Building ${sha} (npm ci, build, prune)"
runuser -u "${RUN_USER}" -- env HOME="${BASE}" npm_config_cache="${BASE}/.npm" \
  bash -c "cd '${release}' && npm ci && npm run build && npm prune --omit=dev"

version="$(release_version "${release}")"
previous="$(current_target)"

log "Switching current -> ${release} (version ${version})"
ln -sfn "${release}" "${CURRENT}"
systemctl restart "${SERVICE}"

log "Waiting up to ${WAIT_SECONDS}s for http://127.0.0.1:${PORT}/healthz to report ${version}"
if wait_healthy "${version}"; then
  log "Healthy"
  prune
  log "Deployed ${sha}"
  exit 0
fi

printf 'ERROR: release %s did not become healthy\n' "${sha}" >&2
if [ -n "${previous}" ]; then
  log "Restoring ${previous}"
  ln -sfn "${previous}" "${CURRENT}"
  systemctl restart "${SERVICE}"
else
  log "No previous release to restore"
fi
exit 1
