#!/usr/bin/env bash
# F20: testbed/build-signed.sh must produce a build whose entitlements still
# carry `keychain-access-groups` -- the flag combination the old ad-hoc
# CODE_SIGNING_ALLOWED=NO gate script strips entirely (TB2 defect 3), which
# silently breaks pairing persistence across a relaunch.
#
# `xcodebuild` and `codesign` are faked: no real Xcode project, no real
# simulator. The fake `xcodebuild` writes a fake entitlements plist that
# mirrors what a REAL build actually does -- signed with an identity,
# CODE_SIGN_STYLE=Manual, keeps whatever `App/CozyChat.entitlements`
# declares; CODE_SIGNING_ALLOWED=NO produces an ad-hoc, unsigned binary with
# no entitlements at all -- and the fake `codesign` reads it back, exactly
# like `codesign -d --entitlements :- <binary>` does for real.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
testbed_dir="$repo_root/testbed"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-build-signed.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT
trap 'status=$?; [ "$status" -eq 0 ] || printf "FAIL  line %s exited %s: %s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR

expect_contains() {
  local haystack="$1" needle="$2"
  if ! grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}
expect_missing() {
  local haystack="$1" needle="$2"
  if grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output NOT to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}

mkdir -p "$tmp/bin" "$tmp/project" "$tmp/derived-signed" "$tmp/derived-unsigned"

cat > "$tmp/project/CozyChat.xcodeproj" <<'EOF'
fake project marker
EOF

# The fake build: writes a marker binary + a sidecar "entitlements" file whose
# contents depend on the CODE_SIGNING_ALLOWED build-setting override, exactly
# like a real signed vs. ad-hoc build does for App/CozyChat.entitlements'
# declared keychain-access-groups entitlement.
cat > "$tmp/bin/xcodebuild" <<'XCB'
#!/usr/bin/env bash
derived=""
signing_allowed="YES"
for a in "$@"; do
  case "$a" in
    -derivedDataPath) want_derived=1; continue ;;
  esac
  if [ "${want_derived:-0}" = "1" ]; then derived="$a"; want_derived=0; continue; fi
  case "$a" in
    CODE_SIGNING_ALLOWED=*) signing_allowed="${a#CODE_SIGNING_ALLOWED=}" ;;
  esac
done
[ -n "$derived" ] || { echo "xcodebuild fake: no -derivedDataPath given" >&2; exit 2; }
out="$derived/Build/Products/Debug-iphonesimulator"
mkdir -p "$out"
touch "$out/CozyChat.app.binary"
if [ "$signing_allowed" = "YES" ]; then
  cat > "$out/CozyChat.app.binary.entitlements" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<plist><dict>
  <key>keychain-access-groups</key>
  <array><string>$(AppIdentifierPrefix)ai.cozylabs.cozychat</string></array>
</dict></plist>
ENT
else
  : > "$out/CozyChat.app.binary.entitlements"
fi
echo "** BUILD SUCCEEDED **"
XCB
chmod +x "$tmp/bin/xcodebuild"

cat > "$tmp/bin/codesign" <<'CS'
#!/usr/bin/env bash
# codesign -d --entitlements :- <binary>
binary="${@: -1}"
cat "${binary}.entitlements" 2>/dev/null || true
CS
chmod +x "$tmp/bin/codesign"

export PATH="$tmp/bin:$PATH"

echo "==> build-signed.sh (the fix)"
COZYCHAT_PROJECT_DIR="$tmp/project" COZYCHAT_SCHEME=CozyChat \
COZYCHAT_SIM_UDID=FAKE-UDID COZYCHAT_DERIVED_DATA="$tmp/derived-signed" \
  "$testbed_dir/build-signed.sh"

signed_entitlements="$(codesign -d --entitlements :- "$tmp/derived-signed/Build/Products/Debug-iphonesimulator/CozyChat.app.binary")"
expect_contains "$signed_entitlements" "keychain-access-groups"
echo "PASS  build-signed.sh keeps keychain-access-groups"

echo "==> the OLD ad-hoc CODE_SIGNING_ALLOWED=NO invocation (the contrast TB2 found)"
xcodebuild build-for-testing -project "$tmp/project/CozyChat.xcodeproj" -scheme CozyChat \
  -destination "id=FAKE-UDID" -derivedDataPath "$tmp/derived-unsigned" \
  CODE_SIGNING_ALLOWED=NO

unsigned_entitlements="$(codesign -d --entitlements :- "$tmp/derived-unsigned/Build/Products/Debug-iphonesimulator/CozyChat.app.binary")"
expect_missing "$unsigned_entitlements" "keychain-access-groups"
echo "PASS  the old CODE_SIGNING_ALLOWED=NO build has no keychain-access-groups entitlement, pinning the contrast"

echo "ALL PASS"
