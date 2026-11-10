#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two applicants and one underwriter. A creates and edits a draft.
# B and the underwriter both get 404 on that draft. A stale PATCH is 409.
#   BASE_URL=http://localhost:3000 DATABASE_URL=postgres://app:app@localhost:5432/app ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_U="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$JAR_U"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is required to grant the underwriter role"
fi

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signin() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\"}" \
    "$BASE_URL/api/auth/sign-in/email" >/dev/null || fail "sign-in failed for $email"
}

EMAIL_A="smoke-a-$RUN_ID@example.test"
EMAIL_B="smoke-b-$RUN_ID@example.test"
EMAIL_U="smoke-uw-$RUN_ID@example.test"

signup "$JAR_A" "$EMAIL_A"
signup "$JAR_B" "$EMAIL_B"
signup "$JAR_U" "$EMAIL_U"
pass "three users signed up"

SMOKE_EMAIL="$EMAIL_U" node --input-type=module <<'EOF' || fail "could not grant the underwriter role"
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`update "user" set role = 'underwriter' where email = ${process.env.SMOKE_EMAIL} returning id`;
await sql.end();
if (rows.length !== 1) process.exit(1);
EOF
signin "$JAR_U" "$EMAIL_U"
pass "underwriter role granted and session refreshed"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/applications")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

created=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{}' "$BASE_URL/api/applications") || fail "create application failed"
id=$(node -e 'const j=JSON.parse(process.argv[1]); if (!j.application?.id) process.exit(1); process.stdout.write(j.application.id);' "$created") \
  || fail "no application id in $created"
pass "applicant A created a draft"

edited=$(curl -fsS -b "$JAR_A" -X PATCH -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"version":1,"purpose":"vehicle"}' "$BASE_URL/api/applications/$id") || fail "edit draft failed"
node -e 'const j=JSON.parse(process.argv[1]); if (j.application?.version !== 2 || j.application?.purpose !== "vehicle") process.exit(1);' "$edited" \
  || fail "edit did not apply: $edited"
pass "applicant A edited the draft"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X PATCH -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"version":1,"purpose":"medical"}' "$BASE_URL/api/applications/$id")
[ "$code" = "409" ] || fail "stale PATCH should be 409, got $code"
pass "stale PATCH is 409"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL/api/applications/$id")
[ "$code" = "404" ] || fail "applicant B should get 404, got $code"
pass "applicant B cannot see A's draft"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U" "$BASE_URL/api/applications/$id")
[ "$code" = "404" ] || fail "underwriter should get 404 on a draft, got $code"
pass "underwriter cannot see A's draft"

# Risk summary route: underwriters only, submitted files only. Everyone else gets the same 404.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/applications/$id/risk")
[ "$code" = "401" ] || fail "anonymous risk GET should be 401, got $code"
for jar in "$JAR_A" "$JAR_B" "$JAR_U"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/api/applications/$id/risk")
  [ "$code" = "404" ] || fail "risk GET on a draft should be 404 (applicant or underwriter), got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d '{}' "$BASE_URL/api/applications/$id/risk")
  [ "$code" = "404" ] || fail "risk POST on a draft should be 404, got $code"
done
pass "risk summary refuses anonymous, applicants and underwriters on a draft"

echo "SMOKE PASS"
