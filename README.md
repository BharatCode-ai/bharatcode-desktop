# BharatCode Desktop

BharatCode Desktop is the native desktop app for BharatCode's OAuth-based coding experience. It bundles the OpenCode runtime with BharatCode sign-in, provider configuration, and the BharatCode model endpoint.

The current public beta path is:

```bash
npm install -g bharatcode@latest
bharatcode auth login
bharatcode opencode configure
```

Desktop first-run shows **Sign in to BharatCode** and uses the same CLI-backed OAuth flow. No user-facing provider API key is required for normal beta use.

## What Is In This Repo

This public scope is Desktop-focused:

- `packages/desktop`: Electron shell, auth handoff, updater, and packaging.
- `packages/app`: Shared app UI used by Desktop.
- `packages/opencode`: Bundled OpenCode runtime.
- `packages/core`, `packages/sdk`, `packages/plugin`, `packages/ui`, `packages/llm`, `packages/http-recorder`, `packages/script`: runtime and build dependencies needed by Desktop.
- `packages/desktop/resources/provider/bharatcode`: Bundled BharatCode provider with OAuth refresh behavior.
- `packages/desktop/resources/capabilities`: Bundled capability catalog and skills shipped with Desktop.

This repo is not the public infrastructure repo for BharatCode. It should not contain production secrets, private deployment runbooks, or internal support records.

## Development

Requirements:

- Bun 1.3+
- Node.js 20+ for tooling that shells out to Node

Install dependencies:

```bash
bun install
```

Run Desktop in development:

```bash
bun --cwd packages/desktop dev
```

Run the shared app UI:

```bash
bun --cwd packages/app dev
```

## Local Checks

Focused Desktop checks:

```bash
cd packages/desktop
bun test src/main/branding.test.ts src/main/bharatcode-auth.test.ts
bun typecheck
```

Package Desktop locally:

```bash
bun --cwd packages/desktop build
bun --cwd packages/desktop package:win
```

Some broader runtime checks require a full Bun install from the repo root.

## Beta Releases

The current public beta release channel builds unsigned Windows installers through GitHub Actions. Public release notes and website download copy should describe those artifacts as beta/unsigned until signing and multi-platform release gates are explicitly approved.

Current channel policy:

- `beta`: public beta artifacts and beta update metadata.
- `prod`: future stable artifacts and production update metadata.
- `dev`: local development only; updater disabled.

Do not publish public installers, update metadata, or marketplace artifacts without explicit release approval.

## Support And Issue Safety

When opening an issue, include:

- BharatCode Desktop version and channel.
- Operating system.
- Install source.
- Visible error text.
- Approximate timestamp.
- Redacted logs or screenshots.

Do not paste OAuth tokens, API keys, credential files, private prompts, private repository links, phone numbers, raw emails, or unredacted debug archives.

## Bundled Capabilities

Desktop includes an optional capability catalog. Some entries require user setup and may send requests to external services when enabled by the user, including GitHub, Playwright, Figma, Linear, Sentry, Supabase, Stripe, and Cloudflare Docs.

The bundled Superpowers skills are attributed to Obra. Keep their license and attribution notes with any redistributed capability files.

## Attribution

BharatCode Desktop is based on OpenCode and retains the upstream MIT license.
