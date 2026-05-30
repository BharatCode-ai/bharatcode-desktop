# BharatCode Desktop

BharatCode Desktop is the BharatCode-branded Electron shell based on OpenCode Desktop.

## Development

```bash
bun install
bun --cwd packages/desktop dev
```

The first-run screen shows **Continue with BharatCode**. It opens the browser with the native BharatCode Supabase OAuth
client, receives the `bharatcode://auth/callback` deep link, stores credentials in `~/.bharatcode/credentials.json`, and
adds the `bharatcode` plugin to the local OpenCode config. No separate OpenCode install or CLI auth step is required.

## Build

```bash
bun --cwd packages/desktop run build
bun --cwd packages/desktop run package
```

Artifacts are written to `packages/desktop/dist/` with BharatCode app metadata, the `bharatcode://` deep-link protocol,
and GitHub release configuration for `BharatCode-ai/bharatcode-desktop`.

## Attribution

BharatCode Desktop is based on OpenCode Desktop and keeps the upstream MIT license.
