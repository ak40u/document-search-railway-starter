#!/usr/bin/env bash
# End-to-end check of a deployed document search pipeline.
#
# It uploads a document containing a sentence nobody would guess, waits for the
# indexer, and then searches for that sentence's *meaning* rather than its
# words. If the right passage comes back, every part of the pipeline worked:
# conversion, chunking, embedding, storage and vector search.
#
#   scripts/verify-search.sh https://your-api.up.railway.app 'the-token'
set -uo pipefail

BASE="${1:?usage: verify-search.sh <base-url> <api-token>}"
TOKEN="${2:?usage: verify-search.sh <base-url> <api-token>}"
BASE="${BASE%/}"
WORK=$(mktemp -d)
failed=0

ok()   { echo "  ok   $1${2:+ - $2}"; }
fail() { echo "  FAIL $1 - $2"; failed=1; }
trap 'rm -rf "$WORK"' EXIT

pick() {
  python3 -c '
import json, sys
try:
    node = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
for part in sys.argv[2:]:
    try:
        node = node[int(part)] if part.isdigit() else node[part]
    except Exception:
        sys.exit(0)
print(node if isinstance(node, str) else json.dumps(node))
' "$@"
}

echo "checking $BASE"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/health")
[ "$code" = "200" ] && ok "health" || fail "health" "got $code"

# 1. The corpus is not readable by whoever finds the URL.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/documents")
[ "$code" = "401" ] && ok "requests without the token are refused" || fail "requests without the token are refused" "got $code"

# 2. Build a document with a fact that appears nowhere else, so a hit cannot be
#    a coincidence.
MARKER="$RANDOM$RANDOM"
cat > "$WORK/report.txt" <<TXT
Field report $MARKER

The marmot population in the northern valley increased by fourteen percent this season.
Revenue from guided tours reached 82,000 euros, mostly in the second half of summer.

Recommendation: extend the observation season by three weeks next year.
TXT
if command -v cupsfilter > /dev/null 2>&1; then
  cupsfilter "$WORK/report.txt" > "$WORK/report.pdf" 2>/dev/null && UPLOAD="$WORK/report.pdf"
fi
UPLOAD="${UPLOAD:-$WORK/report.txt}"
ok "test document prepared" "$(basename "$UPLOAD")"

# 3. Upload returns immediately - the work happens in the indexer.
body=$(curl -s --max-time 120 -X POST "$BASE/documents" -H "authorization: Bearer $TOKEN" -F "file=@$UPLOAD")
ID=$(pick "$body" id)
[ -n "$ID" ] && ok "upload accepted" "document $ID" || fail "upload accepted" "${body:0:200}"

# 4. The same file again is the same document, not a second copy.
dup=$(curl -s --max-time 120 -X POST "$BASE/documents" -H "authorization: Bearer $TOKEN" -F "file=@$UPLOAD")
[ "$(pick "$dup" duplicate)" = "true" ] && ok "re-uploading the same file is a no-op" \
  || fail "re-uploading the same file is a no-op" "${dup:0:200}"

# 5. Wait for the indexer.
status=""
for _ in $(seq 1 60); do
  info=$(curl -s --max-time 30 "$BASE/documents/$ID" -H "authorization: Bearer $TOKEN")
  status=$(pick "$info" status)
  [ "$status" = "ready" ] || [ "$status" = "failed" ] && break
  sleep 5
done
if [ "$status" = "ready" ]; then
  ok "document indexed" "$(pick "$info" chunks) chunks"
else
  fail "document indexed" "status $status: $(pick "$info" error)"
fi

# 6. Search by meaning. None of these words appear in the document - "how many
#    more marmots were there" has to find "population increased by fourteen
#    percent" through the embedding, not through matching text.
body=$(curl -s --max-time 60 -X POST "$BASE/search" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"query":"how much did the rodent numbers grow","limit":3}')
top=$(pick "$body" results 0 text)
case "$top" in
  *"fourteen percent"*) ok "search finds the passage by meaning" "score $(pick "$body" results 0 score)" ;;
  "") fail "search finds the passage by meaning" "no results: ${body:0:200}" ;;
  *) fail "search finds the passage by meaning" "top hit was: ${top:0:120}" ;;
esac

echo
[ "$failed" = "0" ] && echo "all checks passed" || { echo "some checks failed"; exit 1; }
