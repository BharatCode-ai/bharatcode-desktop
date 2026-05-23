# BharatCode VS Code Extension

BharatCode for VS Code launches the BharatCode CLI in an integrated terminal and uses the BharatCode OAuth beta path. Users do not paste provider API keys into the extension.

## Prerequisites

Install the BharatCode CLI:

```bash
npm install -g bharatcode@latest
```

## Sign In

Run **BharatCode: Sign in to BharatCode** from the command palette. The command opens a terminal and runs:

```bash
bharatcode auth login && bharatcode opencode configure
```

The CLI opens browser OAuth against the shared Supabase issuer and stores user credentials in `~/.bharatcode/credentials.json`.

## Features

- **Quick Launch**: Use `Cmd+Esc` on macOS or `Ctrl+Esc` on Windows/Linux to open BharatCode in a split terminal.
- **New Session**: Use `Cmd+Shift+Esc` on macOS or `Ctrl+Shift+Esc` on Windows/Linux to start a new BharatCode terminal session.
- **Context Awareness**: Automatically share your current selection or tab with BharatCode.
- **File Reference Shortcuts**: Use `Cmd+Option+K` on macOS or `Alt+Ctrl+K` on Linux/Windows to insert file references such as `@File#L37-42`.

## OAuth Backend

- Supabase issuer: `https://evgvlcaxfpwupaiwzqqm.supabase.co/auth/v1`
- Native client ID: `4cad332a-232f-4ef2-9363-12fea4420635`
- Reserved VS Code callback: `vscode://bharatcode.bharatcode/auth/callback`
- Model proxy: `https://bharatcode.ai/api/model/v1`

The MVP uses the CLI loopback callback flow because it matches the existing BharatCode public beta auth implementation.

## Development

1. Open `sdks/vscode` in VS Code. Do not open from the repo root.
2. Run `bun install` inside `sdks/vscode`.
3. Press `F5` to start debugging.

To run the local contract tests:

```bash
bun test src/bharatcode.test.ts
```

## Attribution

BharatCode for VS Code is based on OpenCode and keeps the upstream MIT license.
