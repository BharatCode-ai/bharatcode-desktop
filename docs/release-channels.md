# BharatCode Desktop Release Channels & Updater Architecture

This document describes the release channels, auto-updater behavior, publication pipeline, and pre-release smoke checklist for BharatCode Desktop.

---

## 1. Release Channels Matrix

BharatCode Desktop supports three distinct release channels defined in `packages/desktop/src/main/branding.ts` and controlled by the `OPENCODE_CHANNEL` build environment variable:

| Channel               | Target Audience                  | App Display Name  | Application ID               | Auto-Updater            | Tag Pattern          |
| --------------------- | -------------------------------- | ----------------- | ---------------------------- | ----------------------- | -------------------- |
| **`prod`** (`latest`) | General availability / end users | `BharatCode`      | `ai.bharatcode.desktop`      | Enabled (`latest` feed) | No current production promotion path |
| **`beta`**            | Public preview / early adopters  | `BharatCode Beta` | `ai.bharatcode.desktop.beta` | Enabled (`beta` feed)   | `desktop-beta-X.Y.Z` |
| **`dev`**             | Local development & internal CI  | `BharatCode Dev`  | `ai.bharatcode.desktop.dev`  | Disabled                | N/A                  |

---

## 2. Channel Identification & Protocol Registration

Each channel generates isolated user data directories and native application IDs to allow side-by-side installations:

- **Protocol Handler (`bharatcode://`)**: Registered automatically by the packaged desktop app for `prod` and `beta` channels. The `dev` channel and diagnostic instances skip protocol registration to prevent intercepting production OAuth callbacks.
- **Package Names**:
  - `prod`: `bharatcode`
  - `beta`: `bharatcode-beta`
  - `dev`: `bharatcode-dev`

---

## 3. Auto-Updater Architecture

The updater is managed by `createUpdaterController` (`packages/desktop/src/main/updater.ts` and `updater-controller.ts`):

1. **Activation**: Enabled when `app.isPackaged && CHANNEL !== "dev"`.
2. **Download & Install Strategy**:
   - `autoDownload = false`: Updates are never downloaded silently in the background without user consent or notification.
   - `autoInstallOnAppQuit = false`: Updates are not forcefully applied on window close.
   - `allowDowngrade = false`: Downgrades are rejected to protect local database schemas.
3. **Restart Safety**:
   - When the user selects "Restart & Install", `setAppQuitting()` is called prior to `autoUpdater.quitAndInstall()` to ensure window identifiers and workspace session states are saved to store before shutdown.
4. **Persistent State**: Ready update versions are persisted in `bharatcode.updater` store so users can postpone and install later from the native menu or dialog.

---

## 4. Namespaced Beta Updates

The desktop beta feed explicitly isolates desktop client artifacts from server/CLI releases:

- **Feed Discovery (`updater-feed.ts`)**: Queries GitHub Releases via GitHub REST API.
- **Tag Namespacing**: Strictly filters for non-draft, pre-release releases matching the regex:
  ```regex
  ^desktop-beta-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$
  ```
- **Fallback Guard**: If no valid `desktop-beta-X.Y.Z` release exists or if the version payload does not match the tag, the updater errors cleanly rather than falling back to an unrelated CLI release.

---

## 5. Publication Pipeline & Artifact Provenance

Desktop release candidates are built and published through two coordinated workflows:

1. **Candidate Build (`publish.yml`)**: Despite its filename, this is build-only. It builds macOS ARM64 and x64 ZIPs (signed and notarized), Windows x64 and Linux x64 candidates. Windows and Linux artifacts follow the current unsigned policy. Generates `cohort.json` containing SHA-256 digests. A Windows-only target is available for testing but cannot be promoted as a complete release cohort. `build-and-publish.yml` is the separate CLI workflow, not the Desktop candidate builder.
2. **Promotion & Publication (`bharatcode-publish-tested-candidate.yml`)**:
   - Triggered manually via `workflow_dispatch`.
   - Requires explicit inputs: `source_sha`, `build_run_id`, `build_run_attempt`, `candidate_sha256`, and `acceptance_notes`.
   - Enforces a required boolean gate (`manual_acceptance_confirmed: true`).
   - Re-uses exact built artifacts without recompilation, preventing build drift.

The current promotion implementation publishes the beta namespace `desktop-beta-X.Y.Z`; the `prod` branding mode does not by itself establish a production publication workflow. Merging into `dev` does not publish a release. Test and typecheck workflows are also manually dispatched; an empty PR check list is not evidence of a passing build.

---

## 6. Pre-Release Smoke Checklist

Before promoting a Desktop beta candidate, testers must verify the following checklist on clean environments across macOS, Windows, and Linux:

- [ ] **Clean Install**: Application installs successfully; macOS notarization passes, and Windows unsigned/SmartScreen behavior is explicitly recorded rather than claimed to be signed.
- [ ] **First-Run Onboarding**: Fresh launch opens the BharatCode account gate without errors or flash of unstyled content.
- [ ] **OAuth Authentication**: Completes sign-in via `bharatcode://` deep link and stores session credentials securely.
- [ ] **Session & Timeline**: Sends a prompt, verifies streaming token responses, and confirms tool execution.
- [ ] **Window State & Restart**: Resizing/moving windows, quitting, and relaunching restores window positions correctly.
- [ ] **Updater Feed Check**: Manual "Check for Updates" connects to the correct channel feed (`latest` or `beta`).
- [ ] **Diagnostics**: Inspect the actual diagnostic export for tokens, prompts, paths, and sensitive credentials. Proposed support-bundle PRs must not be treated as shipped functionality until integrated and verified.

---

## 7. Platform Considerations

- **macOS**: Signed with Developer ID Application certificate and notarized via Apple notarytool. Hardened runtime enabled with entitlement for JIT compilation.
- **Windows**: Packaged as NSIS installer and portable executable. Respects file locks during auto-updates and database migrations.
- **Linux**: Packaged as AppImage and `.deb`. Uses `libsecret` for secure credential storage where available, with graceful fallback.
