# BharatCode Desktop

BharatCode Desktop is the BharatCode-branded Electron shell based on OpenCode Desktop.

## Development

```bash
bun install
bun --cwd packages/desktop dev
```

The first-run screen shows **Sign in to BharatCode**. The MVP delegates auth to the public beta CLI:

```bash
bharatcode auth login
bharatcode opencode configure
```

That flow uses the native Supabase OAuth client and the loopback callback `http://127.0.0.1:27182/callback`.

## Build

```bash
bun --cwd packages/desktop run build
bun --cwd packages/desktop run package
```

Artifacts are written to `packages/desktop/dist/` with BharatCode app metadata, the `bharatcode://` deep-link protocol, and private GitHub release configuration for `BharatCode-ai/opencode`.

## Attribution

BharatCode Desktop is based on OpenCode Desktop and keeps the upstream MIT license.
