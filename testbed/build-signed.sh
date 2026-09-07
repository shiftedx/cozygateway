#!/usr/bin/env bash
# Build CozyChat for the simulator SIGNED, so a paired gateway survives a
# relaunch. See F20 / TB2 defect 3.
#
# WHY THIS MATTERS: an ad-hoc, unsigned build (CODE_SIGNING_ALLOWED=NO, the
# flag the repo's own scratch gate script and CI both use) produces a binary
# with NO entitlements at all. App/CozyChat.entitlements documents
# `keychain-access-groups` as required: without it, SecItemAdd fails,
# KeychainGatewayCredentialStore stores nothing, and on the next launch
# AppModel.bootstrap treats the still-present `paired_gateway` row as orphaned
# and skips it. Pairing then looks like it worked -- the row is written -- but
# the app shows "no gateway yet" after a terminate/relaunch.
#
# Do NOT "simplify" this by dropping CODE_SIGN_IDENTITY / CODE_SIGN_STYLE /
# DEVELOPMENT_TEAM / PROVISIONING_PROFILE_SPECIFIER, or by copying CI's own
# build flags here: CI never terminates and relaunches the app to test
# Keychain persistence, so it never hits this bug, and is not a template for
# an invocation meant to test pairing across a relaunch.
#
# Usage:
#   COZYCHAT_PROJECT_DIR=<path to the CozyChat checkout> \
#   COZYCHAT_SIM_UDID=<simulator udid> \
#   COZYCHAT_DERIVED_DATA=<path>  \
#     ./build-signed.sh
#
# Every variable above has a default suited to the TB1/TB2 burner bed layout,
# but COZYCHAT_SIM_UDID has no safe default and must be set.
set -euo pipefail

: "${COZYCHAT_SIM_UDID:?set COZYCHAT_SIM_UDID to the target simulator udid, from xcrun simctl list devices}"
COZYCHAT_PROJECT_DIR="${COZYCHAT_PROJECT_DIR:-$HOME/Documents/repos/worktrees/v1-cozychat}"
COZYCHAT_SCHEME="${COZYCHAT_SCHEME:-CozyChat}"
COZYCHAT_DERIVED_DATA="${COZYCHAT_DERIVED_DATA:?set COZYCHAT_DERIVED_DATA to a scratch DerivedData path}"

cd "$COZYCHAT_PROJECT_DIR"

echo "==> signed build-for-testing: $COZYCHAT_SCHEME -> $COZYCHAT_SIM_UDID"
xcodebuild build-for-testing -project "$COZYCHAT_SCHEME.xcodeproj" -scheme "$COZYCHAT_SCHEME" \
  -destination "id=$COZYCHAT_SIM_UDID" -derivedDataPath "$COZYCHAT_DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=
