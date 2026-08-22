#!/bin/bash
#
# End-to-end check of the acceptance scenario in the product brief.
# Requires the app running locally and the seed data in place:
#
#   npm run seed
#   npm run dev
#   ./scripts/acceptance-test.sh [base-url]
#
# It creates one throwaway institution per run. Pass --cleanup to remove it
# afterwards (needs `mongosh` and MONGODB_URI).

set -uo pipefail

BASE="${1:-http://localhost:3000}"
[[ "$BASE" == --* ]] && BASE="http://localhost:3000"
ORIGIN=(-H "Origin: $BASE")
STAMP=$(date +%s)
ADMIN="acceptance-$STAMP@example.test"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

SUPER_EMAIL="${SEED_SUPER_ADMIN_EMAIL:-admin@aemplatform.local}"
SUPER_PASSWORD="${SEED_SUPER_ADMIN_PASSWORD:-ChangeMe!2026}"
OTHER_EMAIL="${OTHER_ADMIN_EMAIL:-admin@infinityschool.edu.in}"
OTHER_PASSWORD="${OTHER_ADMIN_PASSWORD:-Infinity!2026}"

FAILED=0
pass() { printf "  \033[1mPASS\033[0m  %s\n" "$1"; }
fail() { printf "  \033[1mFAIL\033[0m  %s\n          got: %s\n" "$1" "$(echo "$2" | head -c 240)"; FAILED=1; }
chk()  { if echo "$2" | grep -q "$3"; then pass "$1"; else fail "$1" "$2"; fi; }

echo
echo "Acceptance run against $BASE"
echo

echo "1-2  Super admin creates an institution and its first admin"
curl -s -c "$WORK/super.txt" -X POST "$BASE/api/auth/login" "${ORIGIN[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SUPER_EMAIL\",\"password\":\"$SUPER_PASSWORD\"}" -o /dev/null

R=$(curl -s -b "$WORK/super.txt" -X POST "$BASE/api/institutions" "${ORIGIN[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"institutionName\":\"Acceptance Test College\",\"institutionType\":\"PU_COLLEGE\",\"city\":\"Mysore\",\"state\":\"Karnataka\",\"adminName\":\"Acceptance Admin\",\"adminEmail\":\"$ADMIN\",\"adminPassword\":\"Acceptance!2026\"}")
chk "institution created" "$R" '"success":true'
INS=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['institution']['institutionId'])" 2>/dev/null)
[ -z "${INS:-}" ] && { echo "  cannot continue without an institution id"; exit 1; }
echo "       institutionId = $INS"

echo "3-4  Institution admin signs in and sees only its own tenant"
R=$(curl -s -c "$WORK/tenant.txt" -X POST "$BASE/api/auth/login" "${ORIGIN[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN\",\"password\":\"Acceptance!2026\"}")
chk "institution admin signs in" "$R" "\"institutionId\":\"$INS\""
chk "own tenant starts empty" "$(curl -s -b "$WORK/tenant.txt" "$BASE/api/leads")" '"total":0'

echo "5-6  External website posts an enquiry with API credentials"
R=$(curl -s -b "$WORK/tenant.txt" -X POST "$BASE/api/api-clients" "${ORIGIN[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acceptance website","permissions":["CREATE_LEAD","CREATE_APPLICATION","READ_APPLICATION"]}')
chk "API credentials issued" "$R" '"bearerToken"'
TOKEN=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['bearerToken'])")
CLIENT_ID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['client']['id'])")

R=$(curl -s -X POST "$BASE/api/v1/leads" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"studentName":"Rahul Kumar","parentName":"Rajesh Kumar","phone":"9876543210","email":"parent@gmail.com","classInterested":"PUC I","message":"Interested in admission"}')
chk "enquiry lands in the right tenant" "$R" "$INS-LD000001"

echo "7    Another institution cannot see that enquiry"
curl -s -c "$WORK/other.txt" -X POST "$BASE/api/auth/login" "${ORIGIN[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OTHER_EMAIL\",\"password\":\"$OTHER_PASSWORD\"}" -o /dev/null
chk "the other institution cannot find it" \
  "$(curl -s -b "$WORK/other.txt" "$BASE/api/leads?q=$INS-LD000001")" '"total":0'
chk "a client-supplied institutionId is ignored" \
  "$(curl -s -b "$WORK/other.txt" "$BASE/api/leads?institutionId=$INS")" 'INS0001\|"total":0'

echo "8-10 External website submits an admission application"
R=$(curl -s -X POST "$BASE/api/v1/applications" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"academicYear":"2026-27","student":{"firstName":"Rahul","lastName":"Kumar","dateOfBirth":"2016-05-10","gender":"Male"},"parent":{"fatherName":"Rajesh Kumar","motherName":"Anitha Kumar","phone":"9876543210","email":"parent@gmail.com"},"address":{"addressLine1":"Mysore","city":"Mysore","state":"Karnataka","pincode":"570001"},"academic":{"previousInstitution":"ABC School","previousClass":"Grade 10"},"admission":{"applyingFor":"PUC I"}}')
chk "application number is $INS-APP-000001" "$R" "$INS-APP-000001"
APP="$INS-APP-000001"
chk "application appears in the list" "$(curl -s -b "$WORK/tenant.txt" "$BASE/api/applications")" "$APP"

echo "11-12 Status moves SUBMITTED -> UNDER_REVIEW -> APPROVED"
chk "moved to UNDER_REVIEW" \
  "$(curl -s -b "$WORK/tenant.txt" -X PATCH "$BASE/api/applications/$APP" "${ORIGIN[@]}" -H 'Content-Type: application/json' -d '{"status":"UNDER_REVIEW","note":"Documents look complete."}')" \
  '"status":"UNDER_REVIEW"'
chk "moved to APPROVED" \
  "$(curl -s -b "$WORK/tenant.txt" -X PATCH "$BASE/api/applications/$APP" "${ORIGIN[@]}" -H 'Content-Type: application/json' -d '{"status":"APPROVED"}')" \
  '"status":"APPROVED"'

echo "13-15 Print view carries the institution's branding"
PRINT=$(curl -s -b "$WORK/tenant.txt" "$BASE/applications/$APP/print")
chk "print view renders" "$PRINT" "Admission Application"
chk "institution name on the document" "$PRINT" "Acceptance Test College"
chk "application number on the document" "$PRINT" "$APP"

echo "16   PDF download"
curl -s -b "$WORK/tenant.txt" -o "$WORK/app.pdf" "$BASE/api/applications/$APP/pdf"
if [ "$(head -c 4 "$WORK/app.pdf")" = "%PDF" ]; then
  pass "PDF generated ($(wc -c < "$WORK/app.pdf" | tr -d ' ') bytes)"
else
  fail "PDF generated" "not a PDF"
fi

echo "17-18 Revoked credentials stop working"
chk "credentials revoked" \
  "$(curl -s -b "$WORK/tenant.txt" -X DELETE "$BASE/api/api-clients/$CLIENT_ID" "${ORIGIN[@]}")" '"active":false'
chk "revoked credentials rejected" \
  "$(curl -s -X POST "$BASE/api/v1/leads" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"studentName":"Should Fail","phone":"9876543210"}')" \
  'revoked'

echo "19   The platform admin cannot reach institution data"
for ROUTE in "/api/dashboard" "/api/leads" "/api/applications" "/api/applications/$APP" \
             "/api/applications/$APP/notes" "/api/applications/$APP/pdf" \
             "/api/applications/$APP/documents" "/api/leads/$INS-LD000001"; do
  CODE=$(curl -s -b "$WORK/super.txt" -o /dev/null -w '%{http_code}' "$BASE$ROUTE")
  if [ "$CODE" = "403" ]; then pass "403 on $ROUTE"; else fail "403 on $ROUTE" "$CODE"; fi
done
chk "the refusal names the boundary" \
  "$(curl -s -b "$WORK/super.txt" "$BASE/api/leads")" 'Platform administrators cannot access institution data'

echo "20   ...and cannot mint a credential to get around it"
chk "platform admin cannot issue API keys" \
  "$(curl -s -b "$WORK/super.txt" -X POST "$BASE/api/api-clients" "${ORIGIN[@]}" -H 'Content-Type: application/json' -d '{"name":"backdoor","permissions":["READ_APPLICATION"]}')" \
  'FORBIDDEN'
chk "platform admin may still review credential metadata" \
  "$(curl -s -b "$WORK/super.txt" "$BASE/api/api-clients")" '"success":true'

echo "21   Tenant screens redirect the platform admin before rendering"
for ROUTE in "/dashboard" "/enquiries" "/applications" "/applications/$APP" "/applications/$APP/print" "/integration" "/settings"; do
  CODE=$(curl -s -b "$WORK/super.txt" -o /dev/null -w '%{http_code}' "$BASE$ROUTE")
  TO=$(curl -s -b "$WORK/super.txt" -o /dev/null -w '%{redirect_url}' "$BASE$ROUTE")
  if [ "$CODE" = "307" ] && [[ "$TO" == */admin ]]; then
    pass "307 -> /admin on $ROUTE"
  else
    fail "307 -> /admin on $ROUTE" "$CODE $TO"
  fi
done
BODY=$(curl -s -b "$WORK/super.txt" -L --max-redirs 0 "$BASE/applications/$APP" 2>/dev/null)
if echo "$BODY" | grep -q "Rahul Kumar"; then
  fail "no applicant data in the refused response" "student name present"
else
  pass "no applicant data in the refused response"
fi

echo "22   A static website can integrate without credentials"
R=$(curl -s -X POST "$BASE/api/public/$INS/leads" \
  -H "Origin: https://example-school.test" -H 'Content-Type: application/json' \
  -d '{"studentName":"Static Site Visitor","phone":"9845000111","classInterested":"PUC I"}')
chk "no-credential enquiry accepted" "$R" "$INS-LD0000"
chk "public profile readable" "$(curl -s "$BASE/api/public/$INS")" '"institutionName"'
PRE=$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/api/public/$INS/leads" \
  -H "Origin: https://example-school.test" -H "Access-Control-Request-Method: POST")
chk "preflight allows cross-origin POST" "$PRE" 'Access-Control-Allow-Origin'
chk "spec lists the browser-safe path" \
  "$(curl -s "$BASE/api/v1/openapi.json?institution=$INS")" "/api/public/$INS/leads"
chk "browser-safe operation declares no security" \
  "$(curl -s "$BASE/api/v1/openapi.json?institution=$INS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['paths']['/api/public/$INS/leads']['post']['security'])")" \
  '\[\]'

echo "23   Authorization boundaries"
chk "unauthenticated API call rejected" \
  "$(curl -s -X POST "$BASE/api/v1/leads" -H 'Content-Type: application/json' -d '{"studentName":"No Auth","phone":"9876543210"}')" 'UNAUTHORIZED'
chk "institution admin blocked from admin APIs" \
  "$(curl -s -b "$WORK/tenant.txt" "$BASE/api/institutions")" 'FORBIDDEN'
chk "a dashboard session is not an API credential" \
  "$(curl -s -b "$WORK/super.txt" -X POST "$BASE/api/v1/leads" -H 'Content-Type: application/json' -d '{}')" 'UNAUTHORIZED'
chk "validation errors are structured" \
  "$(curl -s -X POST "$BASE/api/v1/leads" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')" 'error'

echo
if [ "$FAILED" -eq 0 ]; then
  printf "\033[1mAll checks passed.\033[0m  Test institution: %s\n" "$INS"
else
  printf "\033[1mSome checks failed.\033[0m  Test institution: %s\n" "$INS"
fi

if [[ " $* " == *" --cleanup "* ]] && command -v mongosh >/dev/null; then
  DB=$(echo "${MONGODB_URI:-mongodb://127.0.0.1:27017/aem_platform}" | sed 's|.*/||; s|?.*||')
  mongosh --quiet "$DB" --eval "
    db.leads.deleteMany({institutionId:'$INS'});
    db.applications.deleteMany({institutionId:'$INS'});
    db.notes.deleteMany({institutionId:'$INS'});
    db.activities.deleteMany({institutionId:'$INS'});
    db.api_clients.deleteMany({institutionId:'$INS'});
    db.users.deleteMany({institutionId:'$INS'});
    db.institutions.deleteMany({institutionId:'$INS'});
    db.counters.deleteMany({_id:{\$regex:'^$INS:'}});
    print('Removed $INS');
  "
fi

exit "$FAILED"
