# BharatCode Desktop And VS Code MVP

This fork implements a minimal BharatCode-branded path on top of OpenCode Desktop and the OpenCode VS Code extension.

## Product Contract

- App name: `BharatCode`
- Desktop protocol: `bharatcode://`
- VS Code extension identity: `bharatcode.bharatcode`
- Supabase issuer: `https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1`
- Native client ID: `4cad332a-232f-4ef2-9363-12fea4420635`
- Model proxy: `https://bharatcode.ai/api/model/v1`

## Auth Flow

The MVP uses the BharatCode CLI as the single token owner:

```bash
bharatcode auth login
bharatcode opencode configure
```

Desktop exposes **Sign in to BharatCode** and runs those commands through IPC. VS Code exposes **BharatCode: Sign in to BharatCode** and runs the same commands in an integrated terminal. Both paths use the CLI loopback callback `http://127.0.0.1:27182/callback`.

The Desktop app registers `bharatcode://auth/callback` and the VS Code extension reserves `vscode://bharatcode.bharatcode/auth/callback`, but direct token exchange is intentionally deferred so the beta does not fork auth behavior while CLI auth is still the source of truth.

## Local Desktop Dev

```bash
npm install -g bharatcode@latest
bharatcode auth login
bharatcode opencode configure

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

1. Verify the latest public beta CLI can complete `bharatcode auth login`, refresh credentials, and run `bharatcode opencode configure`.
2. Replace placeholder Desktop and VS Code icons with final BharatCode assets.
3. Build Desktop artifacts for macOS, Windows, and Linux with `bun --cwd packages/desktop run package`.
4. Sign and notarize installers in CI with BharatCode-controlled signing credentials.
5. Package the VS Code extension with `vsce package`, verify the command palette and terminal launch path, then publish only after explicit approval.
6. Keep public DNS and the A100 serving VM unchanged; this work does not require infrastructure migration.

## Blockers

- If `bharatcode auth login` is unstable, Desktop and VS Code remain blocked on that CLI fix.
- Public installer and marketplace release need final signing credentials and artwork.
- Direct Desktop/VS Code callback token storage requires a separate security review before replacing the CLI-owned token store.
