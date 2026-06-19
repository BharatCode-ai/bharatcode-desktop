# Contributing To BharatCode Desktop

Thanks for helping improve BharatCode Desktop. This repository is focused on the native Desktop app, the bundled OpenCode runtime, BharatCode OAuth sign-in, and the Desktop release/update path.

## Good First Contributions

Good public contributions usually fit one of these areas:

- Desktop install or startup bugs.
- OAuth sign-in and resume issues.
- Model request failures that can be reproduced without sharing private data.
- Windows packaging or update-channel issues.
- Accessibility, keyboard, and UI polish in Desktop.
- Documentation and troubleshooting improvements.

Large product changes should start as an issue before implementation so maintainers can confirm scope.

## Development

Install dependencies from the repo root:

```bash
bun install
```

Run Desktop locally:

```bash
bun --cwd packages/desktop dev
```

Run focused Desktop checks:

```bash
cd packages/desktop
bun test src/main/branding.test.ts src/main/bharatcode-auth.test.ts
bun typecheck
```

## Pull Requests

Before opening a PR:

- Open or reference an issue describing the bug or improvement.
- Keep the PR focused.
- Explain the user-visible problem and the verification you ran.
- Include screenshots or short videos for UI changes.
- Do not include secrets, credential files, private prompts, private repo links, phone numbers, raw emails, or unredacted debug archives.

PR titles should use conventional commit style:

- `fix(desktop): ...`
- `feat(desktop): ...`
- `docs: ...`
- `chore: ...`
- `test: ...`

## Issue Safety

For support and bug reports, provide only redacted information:

- BharatCode Desktop version and channel.
- Operating system.
- Install source.
- Visible error text.
- Approximate timestamp.
- Redacted logs/screenshots.

Never paste OAuth tokens, API keys, credential files, passwords, private prompts, private repository links, phone numbers, raw emails, or unredacted debug archives.
