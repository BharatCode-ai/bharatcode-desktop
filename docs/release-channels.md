# BharatCode Desktop Release Channels & Updater Architecture

This document describes the release channels, auto-updater behavior, publication pipeline, and pre-release smoke checklist for BharatCode Desktop.

---

## 1. Release Channels Matrix

BharatCode Desktop supports three distinct release channels defined in `packages/desktop/src/main/branding.ts` and controlled by the `OPENCODE_CHANNEL` build environment variable:

| Channel               | Target Audience                  | App Display Name  | Application ID               | Auto-Updater            | Tag Pattern          |
| --------------------- | -------------------------------- | ----------------- | ---------------------------- | ----------------------- | -------------------- |
| **`prod`** (`latest`) | General availability / end users | `BharatCode`      | `ai.bharatcode.desktop`      | Enabled (`latest` feed) | `desktop-vX.Y.Z`     |
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

1. **Activation**: Enabled only when `app.isPackaged && CHANNEL !== "dev"` and test onboarding mode is inactive.
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

1. **Candidate Build (`build-and-publish.yml`)**: Compiles, signs, and notarizes binaries for macOS (Universal/ARM64/x64), Windows (x64 NSIS/portable), and Linux (AppImage/deb). Generates `cohort.json` containing SHA-256 digests.
2. **Promotion & Publication (`bharatcode-publish-tested-candidate.yml`)**:
   - Triggered manually via `workflow_dispatch`.
   - Requires explicit inputs: `source_sha`, `build_run_id`, `build_run_attempt`, `candidate_sha256`, and `acceptance_notes`.
   - Enforces a required boolean gate (`manual_acceptance_confirmed: true`).
   - Re-uses exact built artifacts without recompilation, preventing build drift.

---

## 6. Pre-Release Smoke Checklist

Before promoting any Desktop release candidate to public `beta` or `prod`, testers must verify the following checklist on clean environments across macOS, Windows, and Linux:

- [ ] **Clean Install**: Application installs without unsigned binary warnings (notarized on macOS, signed on Windows).
- [ ] **First-Run Onboarding**: Fresh launch opens the BharatCode account gate without errors or flash of unstyled content.
- [ ] **OAuth Authentication**: Completes sign-in via `bharatcode://` deep link and stores session credentials securely.
- [ ] **Session & Timeline**: Sends a prompt, verifies streaming token responses, and confirms tool execution.
- [ ] **Window State & Restart**: Resizing/moving windows, quitting, and relaunching restores window positions correctly.
- [ ] **Updater Feed Check**: Manual "Check for Updates" connects to the correct channel feed (`latest` or `beta`).
- [ ] **Diagnostics**: Generating a support bundle does not include unredacted tokens, prompts, or sensitive credentials.

---

## 7. Platform Considerations

- **macOS**: Signed with Developer ID Application certificate and notarized via Apple notarytool. Hardened runtime enabled with entitlement for JIT compilation.
- **Windows**: Packaged as NSIS installer and portable executable. Respects file locks during auto-updates and database migrations.
- **Linux**: Packaged as AppImage and `.deb`. Uses `libsecret` for secure credential storage where available, with graceful fallback.
