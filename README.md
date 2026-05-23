# BharatCode OpenCode Fork

This private fork builds the BharatCode Desktop app and BharatCode VS Code extension path from OpenCode.

The beta user path is OAuth-first:

```bash
npm install -g bharatcode@latest
bharatcode auth login
bharatcode opencode configure
```

No user-facing provider API key is required. Model traffic goes through:

```text
https://bharatcode.ai/api/model/v1
```

## Shared OAuth Backend

- Supabase issuer: `https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1`
- Native client ID: `4cad332a-232f-4ef2-9363-12fea4420635`
- Desktop deep link: `bharatcode://auth/callback`
- CLI loopback callback: `http://127.0.0.1:27182/callback`
- VS Code callback reserved for future direct callback flow: `vscode://bharatcode.bharatcode/auth/callback`

The current MVP delegates token storage and OpenCode config generation to the BharatCode CLI so Desktop and VS Code share the same auth implementation.

## Desktop Development

```bash
bun install
bun --cwd packages/desktop dev
```

Desktop first-run shows **Sign in to BharatCode**. The button runs:

```bash
bharatcode auth login
bharatcode opencode configure
```

After successful sign-in, Desktop relaunches so the local sidecar picks up the generated BharatCode OpenCode config.

## VS Code Development

```bash
cd sdks/vscode
bun install
code .
```

Press `F5` in VS Code. The extension contributes:

- `BharatCode: Sign in to BharatCode`
- `BharatCode: Open BharatCode`
- `BharatCode: Open BharatCode in new tab`
- `BharatCode: Add Filepath to BharatCode Terminal`

The default terminal command is:

```bash
bharatcode --port <port>
```

## Local Smoke Checks

```bash
cd packages/desktop
bun test src/main/branding.test.ts src/main/bharatcode-auth.test.ts

cd ../../sdks/vscode
bun test src/bharatcode.test.ts
```

Some broader app tests require the full monorepo Bun install.

## Release Plan

1. Confirm the BharatCode CLI auth bug-fix release is published and `bharatcode auth login` succeeds on macOS, Windows, and Linux.
2. Generate final BharatCode icon assets for Desktop and VS Code, replacing the current placeholder icon set.
3. Build signed Desktop installers from CI for macOS, Windows, and Linux using private GitHub releases in `BharatCode-ai/opencode`.
4. Package the VS Code extension as `bharatcode.bharatcode` and test with `vsce package` locally.
5. Publish private/internal artifacts first. Do not publish public installers or marketplace extensions without an explicit release approval.

## Remaining Blockers

- Desktop and VS Code depend on the public beta CLI command `bharatcode auth login`. If that command regresses, these surfaces should keep showing the documented auth error instead of adding a separate token store.
- Final signed installer release needs BharatCode production signing credentials and final artwork.
- Direct VS Code URI callback and Desktop `bharatcode://auth/callback` token exchange are reserved for a later deeper integration. The current MVP uses the CLI loopback callback.

## Attribution

BharatCode Desktop and the BharatCode VS Code extension are based on OpenCode and retain the upstream MIT license.
