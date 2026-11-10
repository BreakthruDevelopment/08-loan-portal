#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two applicants, an underwriter and an admin. A creates and edits a draft.
# B and the underwriter both get 404 on that draft. A stale PATCH is 409.
# Then the document vault: refused uploads, exact download headers, 404 for B and admin,
# the underwriter's 404 on a draft's document and 200 after submit, delete rules.
#   BASE_URL=http://localhost:3000 DATABASE_URL=postgres://app:app@localhost:5432/app ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_U="$(mktemp)"; JAR_ADMIN="$(mktemp)"
WORK="$(mktemp -d)"
trap 'rm -rf "$JAR_A" "$JAR_B" "$JAR_U" "$JAR_ADMIN" "$WORK"' EXIT

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
EMAIL_ADMIN="smoke-admin-$RUN_ID@example.test"

signup "$JAR_A" "$EMAIL_A"
signup "$JAR_B" "$EMAIL_B"
signup "$JAR_U" "$EMAIL_U"
pass "three users signed up"

grant_role() {
  SMOKE_EMAIL="$1" SMOKE_ROLE="$2" node --input-type=module <<'EOF' || fail "could not grant the $2 role"
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`update "user" set role = ${process.env.SMOKE_ROLE} where email = ${process.env.SMOKE_EMAIL} returning id`;
await sql.end();
if (rows.length !== 1) process.exit(1);
EOF
}
grant_role "$EMAIL_U" underwriter
signin "$JAR_U" "$EMAIL_U"
pass "underwriter role granted and session refreshed"
# Better Auth allows 3 sign-ups per 10 seconds per client, so the admin waits for a fresh window.
sleep 11
signup "$JAR_ADMIN" "$EMAIL_ADMIN"
grant_role "$EMAIL_ADMIN" admin
signin "$JAR_ADMIN" "$EMAIL_ADMIN"
pass "admin signed up, granted the role, and signed in"

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

# ---- Document vault -------------------------------------------------------------------------------------------
DOCS="$BASE_URL/api/applications/$id/documents"
printf '%%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$WORK/id.pdf"
# A valid 1x1 PNG.
node -e 'process.stdout.write(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","base64"))' > "$WORK/pay.png"
printf '<html><script>alert(1)</script></html>' > "$WORK/fake.pdf"
printf '%%PDF-1.4\n1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n%%%%EOF\n' > "$WORK/js.pdf"
printf '%%PDF-1.4\ntrailer<</Encrypt 5 0 R>>\n%%%%EOF\n' > "$WORK/locked.pdf"
head -c 6291456 /dev/zero > "$WORK/big.png"

post_doc() { # jar, kind, file, upload-name
  curl -s -o "$WORK/last.json" -w '%{http_code}' -b "$1" -H "origin: $BASE_URL" -F "kind=$2" -F "file=@$3;filename=$4" "$DOCS"
}
last_id() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).document.id)' "$WORK/last.json"; }

code=$(curl -s -o /dev/null -w '%{http_code}' -H "origin: $BASE_URL" -F kind=id -F "file=@$WORK/id.pdf;filename=id.pdf" "$DOCS")
[ "$code" = "401" ] || fail "anonymous upload should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -F kind=id -F "file=@$WORK/id.pdf;filename=id.pdf" "$DOCS")
[ "$code" = "403" ] || fail "upload without an Origin should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: multipart/form-data; boundary=x' -H 'transfer-encoding: chunked' \
  -H "origin: $BASE_URL" --data-binary @"$WORK/id.pdf" "$DOCS")
[ "$code" = "411" ] || fail "upload without Content-Length should be 411, got $code"
[ "$(post_doc "$JAR_A" id "$WORK/big.png" big.png)" = "413" ] || fail "6 MB upload should be 413"
[ "$(post_doc "$JAR_A" id "$WORK/fake.pdf" id.pdf)" = "415" ] || fail "HTML renamed .pdf should be 415"
[ "$(post_doc "$JAR_A" id "$WORK/pay.png" pay.jpg)" = "415" ] || fail "PNG labelled .jpg should be 415"
[ "$(post_doc "$JAR_A" id "$WORK/js.pdf" id.pdf)" = "422" ] || fail "PDF with JavaScript should be 422"
[ "$(post_doc "$JAR_A" id "$WORK/locked.pdf" id.pdf)" = "422" ] || fail "encrypted PDF should be 422"
[ "$(post_doc "$JAR_B" id "$WORK/id.pdf" id.pdf)" = "404" ] || fail "applicant B upload should be 404"
[ "$(post_doc "$JAR_U" id "$WORK/id.pdf" id.pdf)" = "403" ] || fail "underwriter upload should be 403"
[ "$(post_doc "$JAR_ADMIN" id "$WORK/id.pdf" id.pdf)" = "404" ] || fail "admin upload should be 404"
pass "uploads refused: anonymous, no origin, no length, 6 MB, fake PDF, mislabelled PNG, scripted and encrypted PDFs, strangers"

[ "$(post_doc "$JAR_A" id "$WORK/id.pdf" '../../id card.pdf')" = "201" ] || fail "valid PDF upload should be 201: $(cat "$WORK/last.json")"
doc_pdf=$(last_id)
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).document; if (d.displayName.includes("/") || d.contentType!=="application/pdf" || d.sha256) process.exit(1)' "$WORK/last.json" \
  || fail "upload response is wrong: $(cat "$WORK/last.json")"
[ "$(post_doc "$JAR_A" id "$WORK/id.pdf" id.pdf)" = "409" ] || fail "the same file twice should be 409"
[ "$(post_doc "$JAR_A" pay_stub "$WORK/pay.png" pay.png)" = "201" ] || fail "valid PNG upload should be 201"
doc_png=$(last_id)
pass "applicant A uploaded a PDF and a PNG; a duplicate is 409"

listing=$(curl -fsS -b "$JAR_A" "$DOCS") || fail "list documents failed"
node -e 'const j=JSON.parse(process.argv[1]); if (j.documents.length!==2 || JSON.stringify(j).includes("bytes")) process.exit(1)' "$listing" || fail "bad document list: $listing"

curl -s -D "$WORK/headers.txt" -o "$WORK/got.pdf" -b "$JAR_A" "$BASE_URL/api/documents/$doc_pdf" >/dev/null
tr -d '\r' < "$WORK/headers.txt" > "$WORK/headers.clean"
for want in \
  "content-type: application/pdf" \
  "content-disposition: attachment; filename=\"document-$doc_pdf.pdf\"" \
  "x-content-type-options: nosniff" \
  "content-security-policy: default-src 'none'; sandbox" \
  "cache-control: private, no-store" \
  "cross-origin-resource-policy: same-origin"; do
  grep -qixF "$want" "$WORK/headers.clean" || fail "download header missing: $want ($(cat "$WORK/headers.clean"))"
done
cmp -s "$WORK/got.pdf" "$WORK/id.pdf" || fail "downloaded PDF differs from the upload"
inline_cd=$(curl -s -D - -o /dev/null -b "$JAR_A" "$BASE_URL/api/documents/$doc_pdf?inline=1" | tr -d '\r' | grep -i '^content-disposition:')
echo "$inline_cd" | grep -qi 'attachment' || fail "a PDF with ?inline=1 must still download: $inline_cd"
png_cd=$(curl -s -D - -o /dev/null -b "$JAR_A" "$BASE_URL/api/documents/$doc_png?inline=1" | tr -d '\r' | grep -i '^content-disposition:')
echo "$png_cd" | grep -qi "inline; filename=\"document-$doc_png.png\"" || fail "PNG preview header wrong: $png_cd"
pass "download headers are exact; PDFs always download; PNG previews inline"

for jar in "$JAR_B" "$JAR_ADMIN" "$JAR_U"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/api/documents/$doc_pdf")
  [ "$code" = "404" ] || fail "document on a draft should be 404 for B, admin and underwriter, got $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/documents/$doc_pdf")
[ "$code" = "401" ] || fail "anonymous download should be 401, got $code"
pass "another applicant, admin and underwriter get 404 on a draft's document"

# Submit: fill the required fields; the id and pay stub uploaded above satisfy the document rule.
cur=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/applications/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).application.version)))')
filled=$(curl -fsS -b "$JAR_A" -X PATCH -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"version\":$cur,\"amountCents\":1500000,\"termMonths\":36,\"purpose\":\"debt_consolidation\",\"employmentStatus\":\"employed\",\"employerName\":\"Northwind\",\"monthsEmployed\":24,\"annualIncomeCents\":6000000,\"monthlyHousingCents\":120000,\"monthlyDebtCents\":30000,\"creditBand\":\"good\"}" \
  "$BASE_URL/api/applications/$id") || fail "filling the application failed"
ver=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).application.version))' "$filled")

[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X DELETE -H "origin: $BASE_URL" "$BASE_URL/api/documents/$doc_png")" = "204" ] \
  || fail "deleting a draft's document should be 204"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"to\":\"submitted\",\"version\":$ver}" "$BASE_URL/api/applications/$id/transition")
[ "$code" = "409" ] || fail "submitting without an income document should be 409, got $code"
[ "$(post_doc "$JAR_A" pay_stub "$WORK/pay.png" pay.png)" = "201" ] || fail "re-uploading the pay stub should be 201"
doc_png=$(last_id)
pass "delete works on a draft and the submit rule needs an id and an income document"

submitted=$(curl -fsS -b "$JAR_A" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"to\":\"submitted\",\"version\":$ver}" "$BASE_URL/api/applications/$id/transition") || fail "submit failed"
node -e 'if (JSON.parse(process.argv[1]).application.status!=="submitted") process.exit(1)' "$submitted" || fail "not submitted: $submitted"

code=$(curl -s -o "$WORK/uw.pdf" -w '%{http_code}' -b "$JAR_U" "$BASE_URL/api/documents/$doc_pdf")
[ "$code" = "200" ] || fail "underwriter should get 200 after submit, got $code"
cmp -s "$WORK/uw.pdf" "$WORK/id.pdf" || fail "underwriter's copy differs"
for jar in "$JAR_B" "$JAR_ADMIN"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/api/documents/$doc_pdf")
  [ "$code" = "404" ] || fail "B and admin should still get 404 after submit, got $code"
done
[ "$(post_doc "$JAR_A" other "$WORK/id.pdf" again.pdf)" = "409" ] || fail "a new upload after submit should be 409"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X DELETE -H "origin: $BASE_URL" "$BASE_URL/api/documents/$doc_png")
[ "$code" = "409" ] || fail "deleting after submit should be 409, got $code"
pass "underwriter downloads after submit; B and admin stay 404; uploads and deletes are locked"

# ---- Pages (8.4): data-* assertions on the server-rendered HTML --------------------------------------------------
html() { curl -fsS -b "$1" "$BASE_URL$2"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' -b "$1" "$BASE_URL$2"; }
version_of() { curl -fsS -b "$1" "$BASE_URL/api/applications/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).application.version)))'; }

page=$(html "$JAR_A" /applications) || fail "applicant /applications failed"
echo "$page" | grep -q 'data-page="applications"' || fail "applications page marker missing"
echo "$page" | grep -q "data-application-link=\"$id\"" || fail "applications page doesn't list the application"
echo "$page" | grep -q 'data-application-status="submitted"' || fail "applications page is missing the submitted status"
page=$(html "$JAR_A" "/applications/$id") || fail "applicant application page failed"
echo "$page" | grep -q 'data-page="application"' || fail "application page marker missing"
echo "$page" | grep -q 'data-application-status="submitted"' || fail "application page status wrong"
echo "$page" | grep -q "data-document-id=\"$doc_pdf\"" || fail "application page doesn't list the PDF"
echo "$page" | grep -q 'data-deletable="true"' && fail "no document may be deletable after submit"
echo "$page" | grep -qi 'AI summary' && fail "applicant page mentions the AI summary"
[ "$(status_of "$JAR_B" "/applications/$id")" = "404" ] || fail "applicant B's page for A's application should be 404"
for path in /queue "/review/$id" /admin /admin/audit; do
  [ "$(status_of "$JAR_A" "$path")" = "307" ] || fail "applicant on $path should be redirected"
done
for path in /applications /queue "/review/$id"; do
  [ "$(status_of "$JAR_ADMIN" "$path")" = "307" ] || fail "admin on $path should be redirected"
done
[ "$(status_of "$JAR_U" /applications)" = "307" ] || fail "underwriter on /applications should be redirected"
pass "applicant pages: list, detail with locked documents, no AI summary; other roles redirected"

page=$(html "$JAR_U" "/queue?tab=new") || fail "queue failed"
echo "$page" | grep -q 'data-page="queue"' || fail "queue marker missing"
echo "$page" | grep -q 'data-queue-tab="new"' || fail "queue tab marker missing"
echo "$page" | grep -q "data-application-id=\"$id\"" || fail "the submitted application is not in the New queue"
page=$(html "$JAR_U" "/review/$id") || fail "review page failed"
echo "$page" | grep -q 'data-page="review"' || fail "review marker missing"
echo "$page" | grep -q "data-document-id=\"$doc_pdf\"" || fail "review page doesn't list the PDF"
echo "$page" | grep -q "href=\"/api/documents/$doc_pdf\"" || fail "review page doesn't link the download route"
echo "$page" | grep -q 'data-malware-note' || fail "review page is missing the malware note"
echo "$page" | grep -q 'data-can-claim="true"' || fail "review page should offer a claim"
pass "underwriter queue and review pages render with downloads and the claim action"

# Claim, then an internal note and an applicant-visible note.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"to\":\"in_review\",\"version\":$(version_of "$JAR_U")}" "$BASE_URL/api/applications/$id/transition")
[ "$code" = "200" ] || fail "claim should be 200, got $code"
for body in '{"body":"INTERNAL-SMOKE-MARKER","visibility":"internal"}' '{"body":"VISIBLE-SMOKE-MARKER","visibility":"applicant"}'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL/api/applications/$id/notes")
  [ "$code" = "201" ] || [ "$code" = "200" ] || fail "adding a note should succeed, got $code"
done
page=$(html "$JAR_U" "/review/$id")
echo "$page" | grep -q 'data-application-status="in_review"' || fail "review page should show in_review"
echo "$page" | grep -q 'data-can-decide="true"' || fail "assigned underwriter should be able to decide"
echo "$page" | grep -q 'INTERNAL-SMOKE-MARKER' || fail "underwriter should see the internal note"
page=$(html "$JAR_A" "/applications/$id")
echo "$page" | grep -q 'VISIBLE-SMOKE-MARKER' || fail "applicant should see the visible note"
echo "$page" | grep -q 'INTERNAL-SMOKE-MARKER' && fail "applicant must never see the internal note"
pass "internal notes stay internal; applicant-visible notes reach the applicant"

# Decline with codes; the applicant sees the codes but not the decision note.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U" -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"to\":\"declined\",\"version\":$(version_of "$JAR_U"),\"codes\":[\"DTI_TOO_HIGH\"],\"note\":\"DECISION-SMOKE-MARKER\"}" "$BASE_URL/api/applications/$id/transition")
[ "$code" = "200" ] || fail "decline should be 200, got $code"
page=$(html "$JAR_A" "/applications/$id")
echo "$page" | grep -q 'data-decision="declined"' || fail "applicant should see the declined decision"
echo "$page" | grep -q 'data-decision-code="DTI_TOO_HIGH"' || fail "applicant should see the reason code"
echo "$page" | grep -q 'DECISION-SMOKE-MARKER' && fail "applicant must never see the decision note"
page=$(html "$JAR_U" "/review/$id")
echo "$page" | grep -q 'DECISION-SMOKE-MARKER' || fail "underwriter should see the decision note"
pass "decision shows reason codes to the applicant and the note only to the underwriter"

page=$(html "$JAR_ADMIN" /admin) || fail "admin page failed"
echo "$page" | grep -q 'data-page="admin"' || fail "admin marker missing"
echo "$page" | grep -q 'data-status-count="declined"' || fail "admin page is missing the status counts"
echo "$page" | grep -q 'Northwind' && fail "admin page must not show application contents"
page=$(html "$JAR_ADMIN" /admin/audit) || fail "audit page failed"
echo "$page" | grep -q 'data-page="admin-audit"' || fail "audit marker missing"
echo "$page" | grep -q 'data-audit-verify' || fail "audit page is missing the verify control"
echo "$page" | grep -q 'data-audit-count="0"' && fail "audit page shows no events"
echo "$page" | grep -q 'Northwind' && fail "audit page must not show application contents"
verify=$(curl -fsS -b "$JAR_ADMIN" -X POST -H "origin: $BASE_URL" "$BASE_URL/api/admin/audit/verify") || fail "verify failed"
echo "$verify" | grep -q '"ok":true' || fail "audit chain should verify: $verify"
pass "admin counts and audit pages show no contents; the chain verifies"

echo "SMOKE PASS"
