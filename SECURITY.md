# Security

## Threat Model

BharatCode Desktop is a local AI coding app. It can read files, run local commands, and connect to external services that the user enables. The permission system is intended to keep users aware of actions the app is taking; it is not a security sandbox.

If you need strict isolation, run BharatCode Desktop inside a VM, container, or dedicated user account.

## External Services

BharatCode Desktop uses BharatCode OAuth for sign-in and model access. Optional bundled capabilities may connect to external services only when configured or enabled by the user. Examples include GitHub, Playwright, Figma, Linear, Sentry, Supabase, Stripe, and Cloudflare Docs.

Do not share OAuth tokens, API keys, credential files, private prompts, private repository links, phone numbers, raw emails, or unredacted debug archives in public issues.

## Out Of Scope

| Category | Rationale |
| --- | --- |
| User-approved command execution | Desktop is a coding assistant and local command execution is expected behavior. |
| Sandbox escapes | The permission system is not a sandbox. |
| User-configured external services | Data handling for user-enabled external services is governed by those services and the user's configuration. |
| Malicious local config files | Users control their own local configuration and project files. |
| Reports generated without human verification | Automated reports without a reproducible impact path are not actionable. |

## Reporting Security Issues

Please use GitHub Security Advisories for this repository when available. If advisories are not available to you, open a minimal public issue that says you have a security report and wait for a maintainer to provide a private channel.

Do not include exploit details, secrets, private logs, tokens, credential files, or personally identifiable information in a public issue.
