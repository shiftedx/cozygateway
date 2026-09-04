#!/usr/bin/env bash
# Bootstrap only: fetch versioned, checksummed release assets, verify each checksum, then
# hand off to the verified installer payload. Safe for `curl | bash` because
# main is called only after the complete script has been parsed.
set -euo pipefail
REPO="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
HOME_DIR="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
TAG="${COZYGATEWAY_INSTALL_TAG:-}"
ASSET_BASE="${COZYGATEWAY_INSTALL_ASSET_BASE:-}"
EXPLICIT_ASSET_BASE="$ASSET_BASE"
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
canonical_home_dir() {
  local parent base
  case "$HOME_DIR" in ''|/|"$HOME") die "COZYGATEWAY_HOME must name a dedicated directory, never empty, /, or $HOME" ;; esac
  case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd -P)/$HOME_DIR" ;; esac
  parent="$(dirname "$HOME_DIR")"; base="$(basename "$HOME_DIR")"
  [ "$base" != . ] && [ "$base" != .. ] || die "COZYGATEWAY_HOME must not resolve to . or .."
  [ -d "$parent" ] && HOME_DIR="$(cd -P "$parent" && pwd)/$base"
  case "$HOME_DIR" in /|"$HOME") die "COZYGATEWAY_HOME must name dedicated CozyGateway state" ;; esac
  case "$HOME_DIR" in *[!A-Za-z0-9_./-]*) die "COZYGATEWAY_HOME may contain only letters, digits, _, ., /, and -" ;; esac
}
sha256_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else die "sha256 tool required (shasum or sha256sum)"; fi; }
BOOTSTRAP_ASSETS=(cozygateway.mjs cozygateway-hermes-attach-plugin.tar.gz agent-install.sh gateway-supervisor.cjs cozygateway-bootstrap.sh)
BOOTSTRAP_RUNTIME_FILES=(
  local/install-state local/cozygateway.config.json local/gateway.env local/gateway-supervisor.cjs
  local/run-gateway.sh local/dashboard.env local/dashboard-port local/dashboard-owner.ps1
  local/dashboard-owner-elevate.ps1 local/run-gateway.vbs local/cozygateway-task.xml
  bin/cozygateway bin/cozygateway.cmd
)
bootstrap_lock=""
release_bootstrap_lock() {
  [ -z "$bootstrap_lock" ] && return
  rm -f "$bootstrap_lock/pid"
  rmdir "$bootstrap_lock" 2>/dev/null || true
}
handle_bootstrap_signal() {
  release_bootstrap_lock
  exit 128
}
valid_inventory_name() {
  local candidate="$1" asset
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    [ "$candidate" = "$asset" ] || [ "$candidate" = "$asset.sha256" ] && return 0
  done
  return 1
}
valid_runtime_file_id() {
  local candidate="$1" item
  for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do [ "$candidate" = "$item" ] && return 0; done
  return 1
}
bootstrap_path_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
bootstrap_safe_path_and_parents() {
  local path="$1" parent
  [ ! -L "$path" ] || return 1
  parent="$(dirname "$path")"
  while [ "$parent" != / ] && [ "$parent" != . ]; do
    [ ! -L "$parent" ] || return 1
    parent="$(dirname "$parent")"
  done
}
bootstrap_runtime_path() { printf '%s/%s' "$HOME_DIR" "$1"; }
bootstrap_service_registration_path() {
  case "$(bootstrap_service_platform)" in
    Darwin) printf '%s/Library/LaunchAgents/ai.cozylabs.cozygateway.plist' "$HOME" ;;
    Linux) printf '%s/systemd/user/cozygateway.service' "${XDG_CONFIG_HOME:-$HOME/.config}" ;;
  esac
}
bootstrap_snapshot_file() {
  local path="$1" backup="$2" inventory="$3" kind="$4" id="$5" mode
  bootstrap_safe_path_and_parents "$path" || die "refusing redirected bootstrap $kind path"
  if [ -e "$path" ]; then
    [ -f "$path" ] || die "bootstrap $kind is not a regular file: $id"
    mode="$(bootstrap_path_mode "$path")"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "could not read bootstrap $kind mode: $id"
    mkdir -p "$(dirname "$backup/$id")" || die "could not create bootstrap $kind snapshot parent"
    cp "$path" "$backup/$id" || die "could not snapshot bootstrap $kind: $id"
    printf '%s:present:%s:%s\n' "$kind" "$id" "$mode" >> "$inventory"
  else
    printf '%s:absent:%s:-\n' "$kind" "$id" >> "$inventory"
  fi
}
bootstrap_snapshot_service_registration() {
  local path="$1" backup="$2" inventory="$3" mode
  bootstrap_safe_path_and_parents "$path" || die "refusing redirected bootstrap service path"
  if [ -e "$path" ]; then
    [ -f "$path" ] || die "bootstrap service registration is not a regular file"
    mode="$(bootstrap_path_mode "$path")"; [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "could not read bootstrap service mode"
    cp "$path" "$backup/service-registration" || die "could not snapshot bootstrap service registration"
    printf 'service:present:%s\n' "$mode" >> "$inventory"
  else
    printf 'service:absent:-\n' >> "$inventory"
  fi
}
bootstrap_restore_file() {
  local path="$1" source="$2" state="$3" mode="$4" label="$5"
  bootstrap_safe_path_and_parents "$path" || die "refusing redirected bootstrap $label path"
  if [ "$state" = present ]; then
    [ -f "$source" ] && [ ! -L "$source" ] || die "bootstrap snapshot is incomplete or redirected: $label"
    mkdir -p "$(dirname "$path")" || die "could not create bootstrap $label parent"
    cp "$source" "$path.recover.$$" && chmod "$mode" "$path.recover.$$" && mv -f "$path.recover.$$" "$path" || die "could not restore bootstrap $label"
  else
    rm -f "$path" || die "could not remove incomplete bootstrap $label"
  fi
}
acquire_bootstrap_lock() {
  local owner
  [ ! -L "$bootstrap_lock" ] && [ ! -L "$bootstrap_lock/pid" ] || die "refusing redirected bootstrap lock"
  if ! mkdir "$bootstrap_lock" 2>/dev/null; then
    owner="$(cat "$bootstrap_lock/pid" 2>/dev/null || true)"
    case "$owner" in *[!0-9]*|'') ;; *) kill -0 "$owner" 2>/dev/null && die "another CozyGateway bootstrap is running; wait for it to finish and rerun" ;; esac
    rm -f "$bootstrap_lock/pid"
    rmdir "$bootstrap_lock" 2>/dev/null || die "another CozyGateway bootstrap is running; wait for it to finish and rerun"
    mkdir "$bootstrap_lock" || die "could not acquire CozyGateway bootstrap lock"
  fi
  printf '%s\n' "$$" > "$bootstrap_lock/pid" || { rmdir "$bootstrap_lock" 2>/dev/null || true; die "could not record CozyGateway bootstrap lock"; }
}
prepare_owned_dir() {
  local path="$1" owner
  [ -L "$path" ] && die "refusing symlinked installer directory: $path"
  if [ -e "$path" ]; then
    [ -d "$path" ] || die "installer directory is not a directory: $path"
    owner="$(stat -c %u "$path" 2>/dev/null || stat -f %u "$path" 2>/dev/null || true)"
    [ "$owner" = "$(id -u)" ] || die "installer directory is not owned by the current user: $path"
  else
    (umask 077; mkdir -p "$path") || die "could not create installer directory: $path"
  fi
  chmod 700 "$path" || die "could not secure installer directory: $path"
}
recover_bootstrap_transaction() {
  local asset_dir="$1"; shift
  local journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous"
  local state entry name inventory seen='' count=0 version=1 kind item mode extra service_path service_state= service_mode= prior_runtime_state=0 skip_service_restart=0 current_service_present=0
  [ ! -L "$journal" ] && [ ! -L "$journal.next" ] || die "refusing symlinked bootstrap transaction marker"
  [ ! -L "$backup" ] || die "refusing symlinked bootstrap rollback directory"
  if [ ! -e "$journal" ]; then
    [ ! -e "$backup" ] || rmdir "$backup" 2>/dev/null || die "bootstrap snapshots exist without a marker; preserve them and rerun"
    return
  fi
  [ -f "$journal" ] || die "bootstrap transaction marker is not a file"
  state="$(cat "$journal")"
  case "$state" in
    commit=installer-succeeded|restored=previous-release|prepare=replace-release-assets)
      [ ! -e "$backup" ] || rm -rf "$backup" || die "could not finish bootstrap cleanup; journal preserved"
      rm -f "$journal" || die "could not clear completed bootstrap marker"
      return ;;
    intent=replace-release-assets) ;;
    *) die "bootstrap transaction marker is invalid; preserve it and rerun" ;;
  esac
  inventory="$backup/inventory"
  [ -f "$inventory" ] && [ ! -L "$inventory" ] || die "bootstrap transaction inventory is missing or redirected"
  if [ "$(sed -n '1p' "$inventory")" = version=2 ]; then version=2; fi
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ "$entry" = version=2 ] && continue
    case "$entry" in
      present:*|absent:*)
        name="${entry#*:}"; valid_inventory_name "$name" || die "bootstrap transaction inventory is invalid"
        case "|$seen" in *"|asset:$name|"*) die "bootstrap transaction inventory has duplicate assets" ;; esac
        seen="$seen""asset:$name|"; count=$((count + 1))
        [ ! -L "$asset_dir/$name" ] && [ ! -L "$asset_dir/$name.recover.$$" ] || die "refusing redirected installed bootstrap asset"
        if [ "${entry%%:*}" = present ]; then [ -f "$backup/$name" ] && [ ! -L "$backup/$name" ] || die "bootstrap snapshot is incomplete or redirected"; fi ;;
      state:present:*|state:absent:*)
        [ "$version" = 2 ] || die "bootstrap transaction inventory is invalid"
        IFS=: read -r kind state item mode extra <<<"$entry"
        [ -z "$extra" ] && valid_runtime_file_id "$item" && [[ "$mode" =~ ^([0-7]{3,4}|-)$ ]] || die "bootstrap transaction inventory is invalid"
        if [ "$state" = present ]; then [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "bootstrap transaction inventory is invalid"; else [ "$state" = absent ] && [ "$mode" = - ] || die "bootstrap transaction inventory is invalid"; fi
        case "|$seen" in *"|state:$item|"*) die "bootstrap transaction inventory has duplicate runtime state" ;; esac
        seen="$seen""state:$item|"
        if [ "$item" = local/install-state ] && [ "$state" = present ]; then prior_runtime_state=1; fi
        if [ "$state" = present ]; then [ -f "$backup/runtime/$item" ] && [ ! -L "$backup/runtime/$item" ] || die "bootstrap runtime snapshot is incomplete or redirected"; fi ;;
      service:present:*|service:absent:*)
        [ "$version" = 2 ] || die "bootstrap transaction inventory is invalid"
        IFS=: read -r kind state mode extra <<<"$entry"
        [ -z "$extra" ] && [ -z "$service_state" ] || die "bootstrap transaction inventory is invalid"
        if [ "$state" = present ]; then [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "bootstrap transaction inventory is invalid"; else [ "$state" = absent ] && [ "$mode" = - ] || die "bootstrap transaction inventory is invalid"; fi
        service_state="$state"; service_mode="$mode"
        if [ "$state" = present ]; then [ -f "$backup/service-registration" ] && [ ! -L "$backup/service-registration" ] || die "bootstrap service snapshot is incomplete or redirected"; fi ;;
      *) die "bootstrap transaction inventory is invalid" ;;
    esac
  done < "$inventory"
  [ "$count" -eq "$(( ${#BOOTSTRAP_ASSETS[@]} * 2 ))" ] || die "bootstrap transaction inventory is incomplete"
  if [ "$version" = 2 ]; then
    for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do case "|$seen" in *"|state:$item|"*) ;; *) die "bootstrap transaction inventory is incomplete" ;; esac; done
    [ -n "$service_state" ] || die "bootstrap transaction inventory is incomplete"
    # Validate the service while the current wrapper is still present. After
    # restoring an older wrapper, a valid newer unit can no longer be compared
    # to it, but a foreign unit must still block recovery before any mutation.
    if [ "$prior_runtime_state" = 0 ] && [ "$service_state" = absent ]; then
      skip_service_restart=1
    else
      service_path="$(bootstrap_service_registration_path)"
      [ ! -e "$service_path" ] || current_service_present=1
      bootstrap_service_is_owned_or_absent "$service_path" || die "bootstrap service registration is foreign; recovery journal is preserved"
    fi
  fi
  printf 'INFO  recovering an interrupted CozyGateway bootstrap before fetching a new release\n' >&2
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in
      present:*|absent:*)
        name="${entry#*:}"
        if [ "${entry%%:*}" = present ]; then cp "$backup/$name" "$asset_dir/$name.recover.$$" && mv -f "$asset_dir/$name.recover.$$" "$asset_dir/$name" || die "could not restore $name"; else rm -f "$asset_dir/$name" || die "could not remove incomplete bootstrap asset"; fi ;;
      state:*)
        IFS=: read -r kind state item mode <<<"$entry"
        bootstrap_restore_file "$(bootstrap_runtime_path "$item")" "$backup/runtime/$item" "$state" "$mode" "runtime state $item" ;;
    esac
  done < "$inventory"
  if [ "$version" = 2 ] && [ "$skip_service_restart" = 0 ]; then
    bootstrap_restore_file "$service_path" "$backup/service-registration" "$service_state" "$service_mode" 'service registration'
    if [ "$service_state" = absent ]; then remove_new_owned_service_registration || die "could not remove the failed new service registration"; fi
  fi
  if [ "$skip_service_restart" = 0 ]; then
    restart_existing_owned_service || die "previous assets were restored but its service restart failed; recovery journal is preserved"
    printf 'OK    restarted the previous CozyGateway service after the failed update\n' >&2
  else
    printf 'OK    restarted the previous CozyGateway service after the failed update (no prior service was registered)\n' >&2
  fi
  printf 'restored=previous-release\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not record recovered bootstrap state"
  rm -rf "$backup" || die "could not finish bootstrap recovery; journal preserved"
  rm -f "$journal" || die "could not clear recovered bootstrap journal"
}
begin_bootstrap_transaction() {
  local asset_dir="$1" journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous" name item service_path
  [ ! -e "$journal" ] && [ ! -e "$backup" ] || die "bootstrap recovery state already exists; rerun to recover it"
  [ ! -L "$journal" ] && [ ! -L "$journal.next" ] && [ ! -L "$backup" ] || die "refusing redirected bootstrap transaction paths"
  mkdir "$backup" "$backup/runtime" || die "could not create bootstrap rollback directory"
  printf 'prepare=replace-release-assets\n' > "$journal" || { rmdir "$backup/runtime" "$backup" 2>/dev/null || true; die "could not record bootstrap preparation"; }
  printf 'version=2\n' > "$backup/inventory"
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do for name in "$asset" "$asset.sha256"; do
    [ ! -L "$asset_dir/$name" ] || die "refusing symlinked installed bootstrap asset"
    if [ -e "$asset_dir/$name" ]; then printf 'present:%s\n' "$name" >> "$backup/inventory"; cp "$asset_dir/$name" "$backup/$name" || die "could not snapshot $name"; else printf 'absent:%s\n' "$name" >> "$backup/inventory"; fi
  done; done
  for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do bootstrap_snapshot_file "$(bootstrap_runtime_path "$item")" "$backup/runtime" "$backup/inventory" state "$item"; done
  # A fresh bootstrap has no prior Gateway runtime to restore. Do not inspect
  # an unrelated user service with the shared label in that case.
  if [ -e "$HOME_DIR/local/install-state" ]; then
    service_path="$(bootstrap_service_registration_path)"
    bootstrap_service_is_owned_or_absent "$service_path" || die "bootstrap service registration is foreign"
    bootstrap_snapshot_service_registration "$service_path" "$backup" "$backup/inventory"
  else
    printf 'service:absent:-\n' >> "$backup/inventory"
  fi
  printf 'intent=replace-release-assets\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not activate bootstrap transaction"
}
bootstrap_xml_unescape() { printf '%s' "$1" | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g'; }
bootstrap_wrapper_path() { printf '%s/local/run-gateway.sh' "$HOME_DIR"; }
bootstrap_service_platform() {
  case "${COZYGATEWAY_SERVICE_PLATFORM:-$(uname -s)}" in Darwin) printf 'Darwin\n' ;; Linux) printf 'Linux\n' ;; *) die "bootstrap recovery cannot restart an unsupported service platform" ;; esac
}
bootstrap_wrapper_exec_line_is_owned() {
  local wrapper="$1" line
  [ -f "$wrapper" ] && [ ! -L "$wrapper" ] || return 1
  line="$(sed -n '3p' "$wrapper" | tr -d '\r')"
  [ "$(tr -d '\r' < "$wrapper" | awk 'END { print NR }')" = 3 ] && [ "$(sed -n '1p' "$wrapper" | tr -d '\r')" = '#!/usr/bin/env bash' ] && [ "$(sed -n '2p' "$wrapper" | tr -d '\r')" = 'set -euo pipefail' ] && [ "${line#exec }" != "$line" ]
}
bootstrap_systemd_service_is_owned() {
  local unit="$1" wrapper line count wrapper_line
  wrapper="$(bootstrap_wrapper_path)"; [ -f "$unit" ] && [ ! -L "$unit" ] || return 1
  count="$(grep -c '^ExecStart=' "$unit" || true)"; [ "$count" = 1 ] || return 1; line="$(grep '^ExecStart=' "$unit")"
  [ "$line" = "ExecStart=/bin/bash $wrapper" ] && return 0
  bootstrap_wrapper_exec_line_is_owned "$wrapper" || return 1; wrapper_line="$(sed -n '3p' "$wrapper" | tr -d '\r')"; [ "$line" = "ExecStart=${wrapper_line#exec }" ]
}
bootstrap_launchd_service_is_owned() {
  local plist="$1" wrapper actual reconstructed value count wrapper_line
  wrapper="$(bootstrap_wrapper_path)"; [ -f "$plist" ] && [ ! -L "$plist" ] || return 1
  count="$(grep -o '<key>ProgramArguments</key>' "$plist" | wc -l | tr -d ' ')"; [ "$count" = 1 ] || return 1
  actual="$(awk '{ if (!on && match($0, /<key>ProgramArguments<\/key><array>/)) { on=1; $0=substr($0, RSTART+RLENGTH) } if (on) { done=($0 ~ /<\/array>/); if (done) sub(/<\/array>.*/, "", $0); while (match($0, /<string>[^<]*<\/string>/)) { print substr($0, RSTART+8, RLENGTH-17); $0=substr($0, RSTART+RLENGTH) } if (done) exit } }' "$plist" | while IFS= read -r value; do bootstrap_xml_unescape "$value"; printf '\n'; done)"
  [ "$actual" = "$(printf '/bin/bash\n%s' "$wrapper")" ] && return 0
  bootstrap_wrapper_exec_line_is_owned "$wrapper" || return 1; reconstructed=' '; while IFS= read -r value; do printf -v reconstructed '%s%q ' "$reconstructed" "$value"; done <<<"$actual"; wrapper_line="$(sed -n '3p' "$wrapper" | tr -d '\r')"; [ "exec$reconstructed" = "$wrapper_line" ]
}
bootstrap_service_is_owned_or_absent() {
  local path="$1" platform
  [ ! -e "$path" ] && return 0
  platform="$(bootstrap_service_platform)"
  if [ "$platform" = Darwin ]; then bootstrap_launchd_service_is_owned "$path"; else bootstrap_systemd_service_is_owned "$path"; fi
}
remove_new_owned_service_registration() {
  local platform target
  [ "$current_service_present" = 1 ] || return 0
  platform="$(bootstrap_service_platform)"
  if [ "$platform" = Darwin ]; then
    target="gui/$(id -u)/ai.cozylabs.cozygateway"
    launchctl bootout "$target" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now cozygateway.service >/dev/null 2>&1 || return 1
    systemctl --user daemon-reload >/dev/null 2>&1 || return 1
  fi
}
restart_existing_owned_service() {
  local platform plist unit target
  platform="$(bootstrap_service_platform)"
  if [ "$platform" = Darwin ]; then
    plist="$(bootstrap_service_registration_path)"; [ ! -e "$plist" ] && return 0
    bootstrap_launchd_service_is_owned "$plist" || return 1; target="gui/$(id -u)/ai.cozylabs.cozygateway"
    if launchctl print "$target" >/dev/null 2>&1; then launchctl kickstart -k "$target"; else launchctl bootstrap "gui/$(id -u)" "$plist" && launchctl kickstart -k "$target"; fi
  else
    unit="$(bootstrap_service_registration_path)"; [ ! -e "$unit" ] && return 0
    bootstrap_systemd_service_is_owned "$unit" || return 1; systemctl --user daemon-reload && systemctl --user restart cozygateway.service
  fi
}
rollback_bootstrap_transaction() { local asset_dir="$1"; shift; recover_bootstrap_transaction "$asset_dir" "$@"; }
commit_bootstrap_transaction() { local journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous"; printf 'commit=installer-succeeded\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not record bootstrap commit"; rm -rf "$backup" || die "could not remove bootstrap rollback directory"; rm -f "$journal" || die "could not clear bootstrap transaction marker"; }
record_explicit_bootstrap_source() {
  local source_file="$HOME_DIR/local/bootstrap-source" staged
  [ -n "$EXPLICIT_ASSET_BASE" ] || { rm -f "$source_file"; return; }
  case "$EXPLICIT_ASSET_BASE" in file:///*) ;; *) return ;; esac
  prepare_owned_dir "$HOME_DIR/local"
  staged="$source_file.tmp.$$"
  umask 077
  printf '%s\n' "$EXPLICIT_ASSET_BASE" > "$staged"
  chmod 600 "$staged"
  mv "$staged" "$source_file"
}
fetch_verified() {
  local asset="$1" out="$2" expected got
  curl -fsSL "$ASSET_BASE/$asset" -o "$out.new"; curl -fsSL "$ASSET_BASE/$asset.sha256" -o "$out.sha256"
  expected="$(awk '{print $1}' "$out.sha256")"; got="$(sha256_of "$out.new")"
  [ -n "$expected" ] && [ "$expected" = "$got" ] || { rm -f "$out.new"; die "$asset checksum mismatch"; }
  mv "$out.new" "$out"; chmod 700 "$out" 2>/dev/null || true; printf 'OK    verified %s\n' "$asset"
}
main() {
  local asset_dir="$HOME_DIR/bin" stage="" dry_stage="" asset installer_status=0
  # Before anything is fetched: this installs per user under $HOME and registers a user service,
  # and root would leave root-owned state in a person's home that their login cannot start.
  [ "$(id -u)" != 0 ] || die "CozyGateway installs per user under \$HOME and never needs sudo; rerun as yourself."
  command -v curl >/dev/null 2>&1 || die "curl is required"
  canonical_home_dir
  if [ "${COZYGATEWAY_INSTALL_DRYRUN:-}" = 1 ]; then
    dry_stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-bootstrap.XXXXXX")"; stage="$dry_stage"
  else
    prepare_owned_dir "$HOME_DIR"; prepare_owned_dir "$asset_dir"
    bootstrap_lock="$HOME_DIR/.bootstrap-lock"
    acquire_bootstrap_lock
    trap 'release_bootstrap_lock' EXIT
    trap 'handle_bootstrap_signal' HUP INT TERM
    recover_bootstrap_transaction "$asset_dir" "$@"
    stage="$(mktemp -d "$HOME_DIR/.bootstrap.XXXXXX")"
  fi
  trap '[ -z "$stage" ] || rm -rf "$stage"; release_bootstrap_lock' EXIT
  trap 'handle_bootstrap_signal' HUP INT TERM
  if [ -z "$ASSET_BASE" ]; then
    if [ -z "$TAG" ]; then TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"; [ -n "$TAG" ] || die "could not resolve latest release"; fi
    ASSET_BASE="https://github.com/$REPO/releases/download/$TAG"
  fi
  fetch_verified cozygateway.mjs "$stage/cozygateway.mjs"
  fetch_verified cozygateway-hermes-attach-plugin.tar.gz "$stage/cozygateway-hermes-attach-plugin.tar.gz"
  fetch_verified cozygateway-installer.sh "$stage/agent-install.sh"
  fetch_verified gateway-supervisor.cjs "$stage/gateway-supervisor.cjs"
  # Keep the release bootstrap that verified these assets. The installed command
  # uses it for repair so it never treats checkout files as update payloads.
  fetch_verified install.sh "$stage/cozygateway-bootstrap.sh"
  if [ -n "$dry_stage" ]; then rm -rf "$dry_stage"; stage=""; trap - EXIT HUP INT TERM; printf 'DRY   verified assets; would run installer from %s\n' "$HOME_DIR/bin/agent-install.sh"; return; fi
  begin_bootstrap_transaction "$asset_dir"
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    mv "$stage/$asset" "$asset_dir/$asset" || { rollback_bootstrap_transaction "$asset_dir" "$@"; die "could not promote $asset; restored the previous release"; }
    mv "$stage/$asset.sha256" "$asset_dir/$asset.sha256" || { rollback_bootstrap_transaction "$asset_dir" "$@"; die "could not promote $asset checksum; restored the previous release"; }
    if [ "${COZYGATEWAY_TEST_BOOTSTRAP_KILL_AFTER_PROMOTION:-}" = "$asset" ]; then
      kill -KILL "$$"
    fi
  done
  rm -rf "$stage"
  stage=""
  if bash "$HOME_DIR/bin/agent-install.sh" --gateway-dir "$HOME_DIR" --bundle "$HOME_DIR/bin/cozygateway.mjs" --plugin-archive "$HOME_DIR/bin/cozygateway-hermes-attach-plugin.tar.gz" "$@"; then
    record_explicit_bootstrap_source
    commit_bootstrap_transaction
    trap - EXIT HUP INT TERM
    release_bootstrap_lock
    return
  else
    installer_status=$?
  fi
  rollback_bootstrap_transaction "$asset_dir" "$@" || die "installer failed and the previous release could not be restored; the recovery journal is preserved at $HOME_DIR/.bootstrap-transaction"
  die "installer failed; restored the previous CozyGateway release (exit $installer_status)"
}
main "$@"
