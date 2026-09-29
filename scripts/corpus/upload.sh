#!/usr/bin/env bash
# Upload the PostMind corpus videos to Cloudflare R2 with rclone (runbooks/corpus-upload.md).
# The same behaviour as scripts/corpus/upload.ps1, for macOS / Linux / Git Bash.
#
#   scripts/corpus/upload.sh --source /media/videos --files-from ~/corpus-files.txt [--test]
#   scripts/corpus/upload.sh --source /media/videos --files-from ~/corpus-files.txt
#   scripts/corpus/upload.sh --source /media/videos --files-from ~/corpus-files.txt --verify [--quick]
#
# Options: --bucket eu-corpus-source  --prefix videos/  --remote postmind-corpus
#   --config ~/.config/rclone/postmind-corpus.conf  --log-dir ~/postmind-corpus-logs
#   --test-count 20  --transfers 8  --checkers 16  --dry-run
#   RCLONE=/path/to/rclone overrides the rclone binary.
#
# Copies exactly the files in the upload list (npm run corpus:scan -- <folder> --upload-list
# <file>). Re-running resumes: rclone copy skips files already uploaded and unchanged. Nothing is
# deleted. The R2 key is read from the rclone config file; this script holds no secrets.
# rclone flags: https://rclone.org/docs/, https://rclone.org/filtering/,
# https://rclone.org/commands/rclone_check/ (read 2026-09-29).
set -euo pipefail

SOURCE=''
FILES_FROM=''
BUCKET='eu-corpus-source'
PREFIX='videos/'
REMOTE='postmind-corpus'
CONFIG="${HOME}/.config/rclone/postmind-corpus.conf"
LOG_DIR="${HOME}/postmind-corpus-logs"
MODE='copy'
TEST_COUNT=20
QUICK=0
DRY_RUN=0
TRANSFERS=8
CHECKERS=16
RCLONE="${RCLONE:-rclone}"

fail() {
  printf '\nSTOPPED: %s\n' "$1" >&2
  exit 2
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "$1 needs a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) need_value "$@"; SOURCE="$2"; shift 2 ;;
    --files-from) need_value "$@"; FILES_FROM="$2"; shift 2 ;;
    --bucket) need_value "$@"; BUCKET="$2"; shift 2 ;;
    --prefix) [[ $# -ge 2 ]] || fail '--prefix needs a value'; PREFIX="$2"; shift 2 ;;
    --remote) need_value "$@"; REMOTE="$2"; shift 2 ;;
    --config) need_value "$@"; CONFIG="$2"; shift 2 ;;
    --log-dir) need_value "$@"; LOG_DIR="$2"; shift 2 ;;
    --test-count) need_value "$@"; TEST_COUNT="$2"; shift 2 ;;
    --transfers) need_value "$@"; TRANSFERS="$2"; shift 2 ;;
    --checkers) need_value "$@"; CHECKERS="$2"; shift 2 ;;
    --test) [[ "$MODE" == 'copy' ]] || fail 'use --test or --verify, not both'; MODE='test'; shift ;;
    --verify) [[ "$MODE" == 'copy' ]] || fail 'use --test or --verify, not both'; MODE='verify'; shift ;;
    --quick) QUICK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) fail "unknown option $1" ;;
  esac
done

[[ -n "$SOURCE" && -d "$SOURCE" ]] || fail "the video folder '${SOURCE}' was not found (--source)"
[[ -n "$FILES_FROM" && -f "$FILES_FROM" ]] || fail "the upload list '${FILES_FROM}' was not found (--files-from); run npm run corpus:scan -- <folder> --upload-list <file>"
[[ -f "$CONFIG" ]] || fail "the rclone config '${CONFIG}' was not found; run npm run corpus:rclone-config"
command -v "$RCLONE" >/dev/null 2>&1 || fail 'rclone is not installed (https://rclone.org/install/)'
[[ "$REMOTE" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'the remote name may only have letters, digits, - and _'
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "'${BUCKET}' is not a valid bucket name"
[[ "$TEST_COUNT" =~ ^[0-9]+$ && "$TRANSFERS" =~ ^[0-9]+$ && "$CHECKERS" =~ ^[0-9]+$ ]] || fail 'counts must be whole numbers'

CLEAN_PREFIX="${PREFIX//\\//}"
CLEAN_PREFIX="${CLEAN_PREFIX#/}"
CLEAN_PREFIX="${CLEAN_PREFIX%/}"
if [[ -n "$CLEAN_PREFIX" ]]; then DEST="${REMOTE}:${BUCKET}/${CLEAN_PREFIX}"; else DEST="${REMOTE}:${BUCKET}"; fi

mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LIST="$FILES_FROM"

if [[ "$MODE" == 'test' ]]; then
  LIST="${LOG_DIR}/test-batch-${STAMP}.txt"
  grep -v '^$' "$FILES_FROM" | head -n "$TEST_COUNT" > "$LIST" || true
  echo "Test batch: the first $(grep -c . "$LIST" || true) files of the list."
fi

COUNT="$(grep -c . "$LIST" || true)"
COMMON=(--config "$CONFIG" --files-from-raw "$LIST" --checkers "$CHECKERS" --log-level INFO)

if [[ "$MODE" == 'verify' ]]; then
  LOG="${LOG_DIR}/verify-${STAMP}.log"
  MISSING="${LOG_DIR}/verify-${STAMP}-missing.txt"
  DIFFER="${LOG_DIR}/verify-${STAMP}-different.txt"
  ERRORS="${LOG_DIR}/verify-${STAMP}-errors.txt"
  ARGS=(check "$SOURCE" "$DEST" --one-way --missing-on-dst "$MISSING" --differ "$DIFFER" --error "$ERRORS" --log-file "$LOG" "${COMMON[@]}")
  [[ "$QUICK" == 1 ]] && ARGS+=(--size-only)
  echo "Checking ${COUNT} files in ${DEST} against '${SOURCE}'..."
else
  LOG="${LOG_DIR}/upload-${STAMP}.log"
  ARGS=(copy "$SOURCE" "$DEST" --transfers "$TRANSFERS" --retries 5 --retries-sleep 30s --low-level-retries 20 --progress --log-file "$LOG" "${COMMON[@]}")
  [[ "$DRY_RUN" == 1 ]] && ARGS+=(--dry-run)
  echo "Uploading ${COUNT} files from '${SOURCE}' to ${DEST}..."
  echo 'Files already uploaded are skipped. You can stop with Ctrl+C and run the same command again later.'
fi
echo "Log: ${LOG}"
echo

set +e
"$RCLONE" "${ARGS[@]}"
CODE=$?
set -e

echo
if [[ "$CODE" == 0 ]]; then
  if [[ "$MODE" == 'verify' ]]; then echo "OK: all ${COUNT} files are in the bucket and match."
  else echo "OK: finished. ${COUNT} files are in ${DEST}."; fi
else
  echo "rclone stopped with exit code ${CODE}. Nothing is lost: run the same command again to retry."
  echo "Details are in the log: ${LOG}"
fi
exit "$CODE"
