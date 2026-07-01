Copied upstream workflows are intentionally disabled in this BharatCode Desktop repository.

Do not re-enable copied upstream automation without auditing it for BharatCode ownership,
secrets, schedules, notification behavior, and release targets.

The `bharatcode-desktop-windows.yml`, `bharatcode-desktop-macos.yml`, and `bharatcode-desktop-linux.yml` workflows are BharatCode-owned release automation. Keep their release targets, token usage, and public installer wording aligned with the Desktop release runbook before publishing assets.

The macOS workflow signs and notarizes by default. Keep these repository secrets configured before publishing macOS assets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`, and `HOMEBREW_TAP_TOKEN`. Use the workflow-dispatch `allow_unsigned` input only as an explicit emergency fallback.
