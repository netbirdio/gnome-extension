#!/usr/bin/env bash

# Builds the extension ZIP and installs it for the current user.
# `./install.sh --pack-only` only builds the ZIP; `make package` uses it so
# the list of shipped files lives in one place.

set -euo pipefail

extension_uuid='gnome@netbird.io'
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build_dir="$project_dir/build"
archive_path="$build_dir/$extension_uuid.shell-extension.zip"

pack_only=false
case "${1:-}" in
    '') ;;
    --pack-only) pack_only=true ;;
    *)
        printf 'Usage: %s [--pack-only]\n' "$0" >&2
        exit 2
        ;;
esac

if ! command -v gnome-extensions >/dev/null 2>&1; then
    printf 'Error: gnome-extensions is required to install this extension.\n' >&2
    exit 1
fi

mkdir -p "$build_dir"

cd "$project_dir"
gnome-extensions pack --force --out-dir="$build_dir" \
    --extra-source=LICENSE \
    --extra-source=LICENSES \
    --extra-source=icons \
    --extra-source=netbird \
    --extra-source=prefs \
    --extra-source=shell \
    .

if [[ ! -f "$archive_path" ]]; then
    printf 'Error: %s was not created.\n' "$archive_path" >&2
    exit 1
fi

if "$pack_only"; then
    printf 'Built %s\n' "${archive_path#"$project_dir"/}"
    exit 0
fi

gnome-extensions install --force "$archive_path"

printf 'Installed NetBird for GNOME (%s).\n' "$extension_uuid"
printf 'Log out and back in, then enable it with:\n'
printf '  gnome-extensions enable %s\n' "$extension_uuid"
