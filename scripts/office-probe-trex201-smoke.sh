#!/usr/bin/env bash
set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/server/config/office-probe.env"
PROBE_CONFIG="${SWR_OFFICE_PROBE_CONFIG:-$ROOT_DIR/server/config/office-probe.json}"
ENVIRONMENT_ID="${SWR_SMOKE_ENVIRONMENT_ID:-233_setup}"
PYTHON_BIN="${PYTHON:-python}"
LOG_DIR="${SWR_SMOKE_LOG_DIR:-$ROOT_DIR/logs/office-probe}"
RUN_REAL=0
JSON_OUTPUT=0
USE_ALL_ENVIRONMENTS=0
SOURCE_ENV=1
WRITE_LOG=1

usage() {
  cat <<'EOF'
Usage: scripts/office-probe-trex201-smoke.sh [options]

Read-only trex201 office probe smoke sequence:
  1. check-config
  2. dry-run
  3. preflight
  4. optional real office probe with --real

Options:
  --environment-id ID       Limit to one environmentId. Default: 233_setup.
  --all                     Run all configured environments.
  --office-probe-config P   Use a specific office-probe.json.
  --env-file P              Source a specific env file before running.
  --skip-source-env         Do not source server/config/office-probe.env.
  --log-dir P               Write a timestamped log under this directory.
  --no-log                  Do not write a log file.
  --json                    Use JSON output for check-config/preflight/real probe.
  --real                    Also run the real office probe with --require-known.
  -h, --help                Show this help.

Environment:
  PYTHON                    Python executable. Default: python.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment-id)
      ENVIRONMENT_ID="${2:-}"
      shift 2
      ;;
    --all)
      USE_ALL_ENVIRONMENTS=1
      shift
      ;;
    --office-probe-config)
      PROBE_CONFIG="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --skip-source-env)
      SOURCE_ENV=0
      shift
      ;;
    --log-dir)
      LOG_DIR="${2:-}"
      shift 2
      ;;
    --no-log)
      WRITE_LOG=0
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --real)
      RUN_REAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$USE_ALL_ENVIRONMENTS" -eq 0 && -z "$ENVIRONMENT_ID" ]]; then
  echo "--environment-id cannot be empty unless --all is used." >&2
  exit 2
fi

cd "$ROOT_DIR"

if [[ "$WRITE_LOG" -eq 1 ]]; then
  if [[ -z "$LOG_DIR" ]]; then
    echo "--log-dir cannot be empty unless --no-log is used." >&2
    exit 2
  fi
  mkdir -p "$LOG_DIR"
  LOG_SCOPE="$ENVIRONMENT_ID"
  if [[ "$USE_ALL_ENVIRONMENTS" -eq 1 ]]; then
    LOG_SCOPE="all"
  fi
  LOG_FILE="$LOG_DIR/office-probe-${LOG_SCOPE}-$(date +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "$LOG_FILE") 2>&1
  echo "Log file: $LOG_FILE"
fi

if [[ "$SOURCE_ENV" -eq 1 ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    PROBE_CONFIG="${SWR_OFFICE_PROBE_CONFIG:-$PROBE_CONFIG}"
  else
    echo "Env file not found: $ENV_FILE" >&2
    echo "Create it from server/config/office-probe.env.example, or pass --skip-source-env." >&2
  fi
fi

COMMON_ARGS=(--office-probe-config "$PROBE_CONFIG")
if [[ "$USE_ALL_ENVIRONMENTS" -eq 0 ]]; then
  COMMON_ARGS+=(--environment-id "$ENVIRONMENT_ID")
fi

JSON_ARGS=()
if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  JSON_ARGS+=(--json)
fi

run_step() {
  local title="$1"
  shift
  echo
  echo "== $title =="
  "$@"
}

run_step "check-config" "$PYTHON_BIN" -m server.app.office_probe_smoke --check-config "${COMMON_ARGS[@]}" "${JSON_ARGS[@]}" || exit $?
run_step "dry-run" "$PYTHON_BIN" -m server.app.office_probe_smoke --dry-run "${COMMON_ARGS[@]}" || exit $?
run_step "preflight" "$PYTHON_BIN" -m server.app.office_probe_smoke --preflight "${COMMON_ARGS[@]}" "${JSON_ARGS[@]}" || exit $?

if [[ "$RUN_REAL" -eq 1 ]]; then
  run_step "real office probe" "$PYTHON_BIN" -m server.app.office_probe_smoke --probe office --require-known "${COMMON_ARGS[@]}" "${JSON_ARGS[@]}" || exit $?
else
  echo
  echo "Real office probe skipped. Re-run with --real after preflight is clean."
fi
