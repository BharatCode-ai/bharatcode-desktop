# BharatCode Desktop release channels

The public app is **BharatCode** (`prod`). Version **1.15.51** is the first stable release candidate, including bounded connection recovery, student-verification recovery and the latest merged image-history fix. The earlier 1.15.48/1.15.49/1.15.50 builds are superseded unpublished candidates; their test results do not approve this build. The 1.15.47 beta candidate is not a stable installer and cannot be relabeled or promoted as one.

Connection recovery keeps the existing five-retry limit and jittered backoff capped at 30 seconds for transport failures. Cancel interrupts both the active request and a pending backoff. Automatic retries never restart a turn after a local or provider-executed tool has started; completed results remain in history for an explicit continuation. A failure on a later model turn can retry using those existing results without re-executing the tools. Permanent DNS/TLS failures and authorization refusals are not treated as temporary connection resets.

| Installed client | What its updater looks for |
| --- | --- |
| Existing public beta, including 1.15.46 | A GitHub prerelease named `desktop-beta-X.Y.Z` and platform-specific `beta*.yml` |
| Stable Desktop | A non-draft, non-prerelease `desktop-X.Y.Z` and platform-specific `latest*.yml` |
| Development or diagnostic instance | No production auto-update |

Desktop tags are separate from CLI tags. Do not mark a beta tag as stable: that makes it invisible to the old updater.

## First stable release

1. Build a full four-platform stable candidate with `publish.yml`. Record its source SHA, successful run and attempt, and SHA-256 of `cohort.json`. A Windows-only build does not qualify. Windows signing status must be disclosed; macOS requires Developer ID signing and notarization on both architectures.
2. Test both a fresh install and a populated **1.15.46 → stable** upgrade using the exact candidate. Use disposable OS accounts or VMs, never a customer's profile. Check settings, the same project/chat history, account continuity, and reopening after quit. Check website login via `bharatcode://`, a streamed answer and tool call, GLM Low/High, and a metadata-only support export. Verify the product name is BharatCode and the title bar has no beta badge.
3. Verify the native install: NSIS updates the original installation on Windows; on macOS the old app updates and can still use its credential store; the Linux AppImage updater resolves the correct payload, and an existing Debian package upgrades without installing a second package. Do not confuse a unit test or an extracted archive with an installed upgrade.
4. After acceptance, use the separate tested-candidate publication workflow. It promotes the exact verified files, never rebuilds them. Verify the canonical stable tag, download hashes and stable updater metadata **before** making the one-time beta compatibility feed public.
5. The compatibility prerelease is only a pointer for old clients, not a second installer or an ongoing beta track. Confirm an old client finds it, fetches the canonical bytes, and subsequently checks the stable feed. Verify the website offers the canonical stable installers on all platforms.

## Protecting installed data

The stable display name and release channel are separate from the historical native installation and storage identifiers. Keep the latter compatible with the beta so the existing session database, settings, credentials and WSL state stay in place. An internal path or package identifier containing `beta` is expected. Do **not** rename/delete these directories or copy a live SQLite database to make the name look cleaner. Development and diagnostic profiles remain separate.

Users still choose when to download and restart. Never force a downgrade of an upgraded database. If the exact installed upgrade fails, stop before publishing and preserve the beta release and profile for diagnosis.
