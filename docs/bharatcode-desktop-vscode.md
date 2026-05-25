# BharatCode Desktop And VS Code Beta

This fork implements the BharatCode-branded desktop app and VS Code extension on top of OpenCode.

## Product Contract

- App name: `BharatCode`
- Desktop protocol: `bharatcode://`
- VS Code extension identity: `bharatcode.bharatcode`
- Supabase issuer: `https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1`
- Native client ID: `4cad332a-232f-4ef2-9363-12fea4420635`
- Model proxy: `https://bharatcode.ai/api/model/v1`

## Auth Flow

Desktop uses the native BharatCode Supabase OAuth client directly. The first-run **Continue with BharatCode** action opens
the browser, waits for `bharatcode://auth/callback`, exchanges the PKCE authorization code, stores credentials in
`~/.bharatcode/credentials.json`, and adds the `bharatcode` plugin to the local OpenCode config.

The VS Code extension still delegates to the BharatCode CLI for beta:

```bash
bharatcode auth login
bharatcode opencode configure
```

VS Code exposes **BharatCode: Sign in to BharatCode** and runs those commands in an integrated terminal.

## Local Desktop Dev

```bash
bun install
bun --cwd packages/desktop dev
```

Targeted checks:

```bash
cd packages/desktop
bun test src/main/branding.test.ts src/main/bharatcode-auth.test.ts
```

## Local VS Code Dev

```bash
npm install -g bharatcode@latest
cd sdks/vscode
bun install
code .
```

Press `F5`, then run **BharatCode: Sign in to BharatCode** in the extension host.

Targeted checks:

```bash
cd sdks/vscode
bun test src/bharatcode.test.ts
```

## Release Plan

1. Verify Desktop can complete native OAuth through `bharatcode://auth/callback` and write `~/.bharatcode/credentials.json`.
2. Verify the latest public beta CLI can complete `bharatcode auth login`, refresh credentials, and run `bharatcode opencode configure` for VS Code.
3. Build Linux Desktop artifacts with `BHARATCODE_CHANNEL=beta bun --cwd packages/desktop run package:linux`.
4. Build the current unsigned Windows beta through the `BharatCode Desktop Windows` GitHub Actions workflow.
   The workflow sets `BHARATCODE_ALLOW_UNSIGNED_WINDOWS=1` intentionally; users should expect Windows
   SmartScreen to show an unknown-publisher warning until BharatCode has a signing certificate path.
5. Sign and notarize macOS installers in CI with BharatCode-controlled Apple signing credentials before public macOS distribution.
6. Package the VS Code extension with `vsce package`, verify the command palette and terminal launch path, then publish only after explicit approval.
7. Keep public DNS and the A100 serving VM unchanged; this work does not require infrastructure migration.

## Blockers

- If `bharatcode auth login` is unstable, VS Code remains blocked on that CLI fix.
- Windows beta can be published as an unsigned direct-download artifact for now. Signed Windows distribution still
  needs Azure Trusted Signing or an OV/EV code-signing certificate.
- Public macOS release still needs Apple signing and notarization credentials.
