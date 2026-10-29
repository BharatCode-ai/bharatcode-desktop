# Contributing to BharatCode Desktop

Welcome to BharatCode Desktop! We are excited to collaborate with the community. This document outlines everything you need to know to get started, set up your development environment, understand the monorepo architecture, and submit quality contributions.

---

## Table of Contents

1. [Repository Scope & Ownership](#repository-scope--ownership)
2. [Security & Privacy Guardrails (What NOT to Post)](#security--privacy-guardrails-what-not-to-post)
3. [Finding Something to Work On](#finding-something-to-work-on)
4. [Prerequisites & Environment Setup](#prerequisites--environment-setup)
5. [Monorepo Architecture Map](#monorepo-architecture-map)
6. [Daily Development Workflow & Commands](#daily-development-workflow--commands)
7. [Verification Suite](#verification-suite)
8. [Pull Request & Git Conventions](#pull-request--git-conventions)
9. [Coding Style & Best Practices](#coding-style--best-practices)

---

## Repository Scope & Ownership

BharatCode Desktop is the official desktop distribution and client ecosystem for BharatCode. It combines the local AI development engine with an Electron desktop application, first-party authentication, automatic updates across release channels, and localized developer tools.

### What This Repository Owns

- **Desktop Application (`packages/desktop`)**: Electron main process, preload security boundary, window lifecycle, power monitor integration, native menus, and auto-updater.
- **Local Engine & Server (`packages/opencode`)**: Core runtime, local HTTP/SSE sidecar, CLI, TUI, SQLite storage & schema migrations, provider integrations, and OAuth token management.
- **Shared Desktop/Web UI (`packages/app`)**: SolidJS timeline, session management, onboarding, account gates, and internationalization (i18n).
- **Shared Core & UI Libraries (`packages/core`, `packages/ui`, `packages/client`, `packages/sdk`)**: Shared schemas, client protocols, design primitives, and SDK bindings.

---

## Security & Privacy Guardrails (What NOT to Post)

> [!CAUTION]
> **Never commit or post sensitive information in GitHub issues, PR descriptions, test fixtures, logs, or screenshots.**

To protect your privacy and project security, ensure that you **never** share:

- **API keys and tokens**: OpenAI, Anthropic, Gemini, BharatCode OAuth tokens, personal access tokens, or refresh tokens.
- **Session credentials**: `.credentials.json`, `auth.json`, cookies, or authorization headers.
- **Customer / Private code**: Internal proprietary source code, proprietary algorithms, or confidential business logic.
- **Raw prompts and outputs containing personal data**: Real names, email addresses, phone numbers, IP addresses, or internal network endpoints.
- **Private repository URLs**: URLs containing access tokens or referencing internal private repositories.

If you are reporting a bug or submitting a test, use synthetic data (e.g. `test-token-12345`, `user@example.com`, `https://example.com/api`).

---

## Finding Something to Work On

All contributors are encouraged to browse open issues:

- [`good first issue`](https://github.com/BharatCode-ai/bharatcode-desktop/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — approachable issues ideal for first-time contributors.
- [`help wanted`](https://github.com/BharatCode-ai/bharatcode-desktop/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) — identified priorities where external help is appreciated.
- [`bug`](https://github.com/BharatCode-ai/bharatcode-desktop/issues?q=is%3Aissue+is%3Aopen+label%3Abug) — confirmed defects.
- [`area: docs`](https://github.com/BharatCode-ai/bharatcode-desktop/issues?q=is%3Aissue+is%3Aopen+label%3A%22area%3A+docs%22) — documentation additions and corrections.

Please leave a comment on an issue before starting work so maintainers can assign it to you and prevent duplicated effort.

---

## Prerequisites & Environment Setup

### Required Tools

- **Runtime & Package Manager**: [Bun](https://bun.sh) `v1.3.14` (the authoritative workspace package manager specified in `package.json`).
- **Node.js**: Node 22+ or 24 LTS (used by native tooling and Electron build scripts).
- **Git**: Git 2.30+.
- **Platform-specific build tools**:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: Standard build essentials (`build-essential`, `libsecret-1-dev`).
  - **Windows**: Visual Studio C++ Build Tools or Windows SDK (for optional native modules).

### Cloning & Installing

```bash
git clone https://github.com/BharatCode-ai/bharatcode-desktop.git
cd bharatcode-desktop

# Install all workspace dependencies
bun install
```

---

## Monorepo Architecture Map

```
bharatcode-desktop/
├── packages/
│   ├── desktop/            # Electron main process, preload, and renderer shell
│   │   ├── src/main/       # Window management, updater, power monitor, auth session
│   │   ├── src/preload/    # Context isolation and safe IPC bridges
│   │   └── src/renderer/   # Account gate, onboarding, and desktop shell UI
│   ├── opencode/           # Core server runtime, CLI, TUI, and SQLite storage
│   │   ├── src/auth/       # BharatCode OAuth flows and token storage
│   │   ├── src/migration/  # SQLite schema migrations and repair journal
│   │   ├── src/server/     # Headless HTTP/SSE server
│   │   └── src/cli/        # CLI entrypoints and interactive TUI
│   ├── app/                # Shared SolidJS web and desktop frontend application
│   │   ├── src/i18n/       # Internationalization dictionaries and parity tests
│   │   └── src/pages/      # Chat timeline, prompts, settings, and diff viewers
│   ├── ui/                 # Reusable design system components and primitives
│   ├── core/               # Shared business logic, session runner, and models
│   ├── client/             # Typed HTTP client communicating with opencode server
│   ├── protocol/           # Wire protocols and DTO definitions
│   └── sdk/                # Generated client SDK bindings
└── docs/                   # Architecture, release channels, and migration guides
```

---

## Daily Development Workflow & Commands

### Running Applications

```bash
# Start the core CLI / TUI in the current directory
bun dev

# Start the Electron Desktop application in development mode
bun dev:desktop

# Start the shared Web application in development mode
bun dev:web

# Run the headless core server on port 4096
bun dev serve --port 4096
```

### Building & Packaging

```bash
# Build the Electron desktop app
bun run --cwd packages/desktop build

# Package desktop executables for your current platform
bun run --cwd packages/desktop package
```

---

## Verification Suite

Before submitting a pull request, run the verification suite to ensure code quality and prevent regressions:

```bash
# 1. Typecheck all packages
bun turbo typecheck

# 2. Lint the repository
bun run lint

# 3. Run unit tests across packages
bun turbo test

# 4. Check code formatting
bun run prettier --check .
```

To run tests for a single package:

```bash
# Test desktop package
bun test src --cwd packages/desktop

# Test core opencode package
bun test --cwd packages/opencode --timeout 30000
```

---

## Pull Request & Git Conventions

Strictly adhere to the following repository standards (see also [`AGENTS.md`](./AGENTS.md)):

### 1. Issue First Policy

All pull requests must resolve an open issue. Reference the issue in your PR description:
`Closes #123` or `Fixes #123`.

### 2. Branch Naming

- Create your branch directly from the latest `dev` branch.
- Branch names must be short (at most 3 words), lowercase, hyphen-separated.
- **Do NOT** use slashes or type prefixes (e.g., no `feat/`, `fix/`, `bug/`).
- **Examples**: `contributor-guide`, `sqlite-repair`, `auth-session-refresh`.

### 3. Commit Messages & PR Titles

- Use conventional commit style: `type(scope): summary`.
- The summary must be lowercase with **no trailing period**.
- Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Scopes: `desktop`, `opencode`, `app`, `core`, `ui`, `client`, `docs`.
- **Examples**:
  - `docs: update contributor guide with monorepo map`
  - `fix(desktop): deduplicate session refresh on machine resume`
  - `fix(core): repair sqlite schema without dropping chat tables`

### 4. Verification Details & PR Descriptions

- Keep descriptions clear, concise, and human-written. Do not submit AI-generated walls of text.
- Detail what was tested and how reviewers can reproduce your verification.
- For UI changes, attach screenshots or short video recordings showing before and after.

---

## Coding Style & Best Practices

- **Minimal abstraction**: Inline logic at the call site unless it is genuinely reused or composes distinct functionality.
- **Control flow**: Avoid `else` blocks; prefer early returns.
- **Error handling**: Avoid unstructured `try`/`catch` where possible.
- **Types**: Avoid `any`. Rely on precise types and TypeScript inference.
- **Bun APIs**: Prefer native Bun APIs (e.g. `Bun.file()`) over Node equivalents when executing in the Bun runtime.
- **Immutability**: Prefer `const` over `let`. Avoid unnecessary object/array mutations.
- **Imports**: Never use star imports (`import * as Foo`) or import renaming (`import { a as b }`).
