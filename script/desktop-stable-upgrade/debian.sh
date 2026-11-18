#!/usr/bin/env bash
# Never install on a developer machine or production server.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" = true && "${RUNNER_ENVIRONMENT:-}" = github-hosted && "${BHARATCODE_VERSION:-}" = 1.15.50 ]]
asset=bharatcode-desktop-linux-amd64.deb
old="$RUNNER_TEMP/public-11546.deb"
new="$RUNNER_TEMP/candidate/linux-x64/$asset"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  "https://github.com/BharatCode-ai/bharatcode-desktop/releases/download/desktop-beta-1.15.46/$asset" -o "$old"
printf '%s  %s\n' f1a9764c5960a2d4847d894b6d180c996a0f4e0e3b35c0377a282a2cfab8c128 "$old" | sha256sum -c -
for pkg in "$old" "$new"; do [[ "$(dpkg-deb -f "$pkg" Package)" = bharatcode-beta ]]; done
sudo apt-get -o DPkg::Lock::Timeout=60 -y --no-install-recommends install "$old"
[[ "$(dpkg-query -W -f='${Version}' bharatcode-beta)" = 1.15.46 ]]
profile="${XDG_CONFIG_HOME:-$HOME/.config}/ai.bharatcode.desktop.beta"
mkdir -p "$profile"
printf 'synthetic-settings-marker\n' > "$profile/upgrade-test-only.txt"
sudo dpkg -i "$new"
[[ "$(dpkg-query -W -f='${Version}' bharatcode-beta)" = "$BHARATCODE_VERSION" ]]
[[ "$(cat "$profile/upgrade-test-only.txt")" = synthetic-settings-marker ]]
echo 'PASS: installed public 1.15.46 then upgraded its Debian package in place; profile marker preserved.'
