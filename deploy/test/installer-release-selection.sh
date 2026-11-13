#!/usr/bin/env bash
# Test stable-vs-dev installer release selection without network or installation.
set -euo pipefail

red='' yellow='' plain=''

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
installer=${INSTALLER_UNDER_TEST:-"$repo_root/install.sh"}

load_function() {
    local definition
    definition=$(awk -v name="$1" '
        $0 == name "() {" {copy = 1}
        copy {print}
        copy && /^}$/ {exit}
    ' "$installer")
    [[ -n "$definition" ]] || { echo "Missing installer function: $1" >&2; return 1; }
    eval "$definition"
}

load_function resolve_latest_tag

arch() { printf 'amd64\n'; }

# The resolver only needs the stable latest redirect in these tests.
curl() {
    local last="${!#}"
    [[ "$last" == "https://github.com/hcmteam/H-Panel/releases/latest" ]] || return 1
    printf 'https://github.com/hcmteam/H-Panel/releases/tag/1.0.0\n'
}

release_asset_available() {
    case "$1" in
        */1.0.0/x-ui-linux-amd64.tar.gz) [[ "${STABLE_ASSET_AVAILABLE:-0}" == 1 ]] ;;
        */dev-latest/x-ui-linux-amd64.tar.gz) [[ "${DEV_ASSET_AVAILABLE:-1}" == 1 ]] ;;
        *) return 1 ;;
    esac
}

expect_tag() {
    local expected="$1" actual
    actual=$(resolve_latest_tag) || { echo "Resolver failed; expected $expected" >&2; return 1; }
    [[ "$actual" == "$expected" ]] || {
        echo "Resolver selected $actual; expected $expected" >&2
        return 1
    }
    printf 'PASS selected %s\n' "$actual"
}

STABLE_ASSET_AVAILABLE=1 expect_tag 1.0.0
STABLE_ASSET_AVAILABLE=0 DEV_ASSET_AVAILABLE=1 expect_tag dev-latest

if STABLE_ASSET_AVAILABLE=0 DEV_ASSET_AVAILABLE=0 resolve_latest_tag > /dev/null 2>&1; then
    echo 'Resolver unexpectedly succeeded without an installable asset' >&2
    exit 1
fi
printf 'PASS fails clearly when no installable release exists\n'
