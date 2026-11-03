# Project memory

Project memory lets the model remember facts about a project across chats, such as "this project uses
Bun, not npm" or "tests live in packages/x/test". Each new chat starts already knowing them instead of
re-reading files. It works with any model that can call tools, including Qwen and DeepSeek.

## How it works

- **One tool, `save_memory(fact)`.** The model saves one short sentence when the user asks it to
  remember something, or when it learns a lasting project convention.
- **One private file per project:** `<data>/memory/<project-id>/MEMORY.md`. It lives in BharatCode's
  data folder, never in the user's repo, and it is plain Markdown the user can open and edit.
- **Loaded into every chat automatically.** The newest facts load, up to about 1,000 tokens, with a note
  that `AGENTS.md`, the user's instructions and the actual code always win over a remembered fact.
- **Same project, same memory.** Memory is keyed by BharatCode's project ID, so every clone and git
  worktree of a repo shares it. Folders without git get their own memory.
- **Shipped through the Marketplace** as "Project memory": bundled, on by default in desktop, and it can
  be turned off. It is a small MCP server that runs on the app's own runtime, so users don't need
  Node.js installed.

Code:
- `packages/opencode/src/bharatcode/memory.ts`: memory logic
- `packages/opencode/src/bharatcode/memory-server.ts`: MCP server
- `packages/opencode/script/bundle-memory-server.ts`: builds `packages/core/src/capabilities/memory-server.json`
- `packages/core/src/capabilities.ts`: Marketplace wiring

Rebuild the bundle after changing either `memory*.ts` file.

## Safety rules for saving

- One line, at most 500 characters, and not empty.
- Exact duplicates are skipped.
- Text that looks like a secret (API keys, tokens, private keys) is refused.
- A save only counts when the tool actually writes the file, and the tool's reply confirms it.

## Why this design

### What other coding agents do

| Agent | Rules people write | Facts the agent saves |
|---|---|---|
| Claude Code | `CLAUDE.md` in the repo | Private per project: `~/.claude/projects/<project>/memory/MEMORY.md`, loaded each chat |
| Qwen Code | `QWEN.md` | One `save_memory` tool appending to a Markdown file loaded each chat |
| Codex | `AGENTS.md` | Private per user, off by default |
| Cursor | `.cursor/rules`, `AGENTS.md` | Removed its memories in 2.1 (Nov 2025) |

The common pattern has two layers. Rules people write go in the repo and are shared. Facts the agent
saves go in a private file outside the repo, and the agent never edits the committed file on its own.

Cursor gave no official reason for removing its memories. User reports describe these problems:
- memories saved when "the UI decided to"
- the agent claiming to save memories that never appeared
- no project scope
- different memories on each machine
- unclear priority between rules and memories

This design avoids each of them.

### Options we didn't pick

- **Official MCP memory server (knowledge graph):** 9 tools, and the model must decide to search before
  it remembers anything. That's harder for a 27B model.
- **Basic Memory and Serena:** AGPL/GPL licences and heavier setup.
- **Mem0 / OpenMemory:** needs a second model for extraction and an embeddings service.
- **Engram (DeepSeek Harness):** a DSH-only plugin with 21 tools. We borrowed its per-chat size budget.

### What the research says

- **[VibeMemBench](https://arxiv.org/abs/2609.23570)** (Sep 2026) tested memory systems for coding agents
  on 111 tasks from 90 real repositories.
  - In 11 of 12 cases, existing memory systems did no better than having no memory.
  - Injecting verified experience directly raised solved tasks by 1–4.5 points and cut steps for every
    model.
  - Our design follows that pattern: deliberate facts, injected directly.
- **[SWE-ContextBench](https://arxiv.org/abs/2602.08316)** (Feb 2026): short, accurate summaries of past
  experience help, especially on hard tasks. Unfiltered or wrong context helps little or hurts, which is
  why facts are kept short, deduplicated and size-limited.
- **[DreamBench-SWE](https://arxiv.org/abs/2608.20664)** (Aug 2026): when tasks depend on earlier
  sessions, memory makes a large difference (21 of 180 solved without memory against 82–97 with it). No
  single memory design was proven better.
- **[Security of long-term agent memory](https://arxiv.org/html/2604.16548v1)** (survey): writing to
  memory is an attack surface. A malicious file could trick the model into saving a harmful "fact" that
  loads into later chats. We reduce this by marking memories as hints that the code and `AGENTS.md`
  override, and by keeping the file visible and editable. The risk is not fully removed.
- Broad surveys:
  - [Memory for Autonomous LLM Agents](https://arxiv.org/pdf/2603.07670)
  - [Agent Memory in the Second Half](https://arxiv.org/pdf/2602.06052)

## Credits

- The `save_memory` tool follows Qwen Code's memory tool (Apache-2.0).
- The per-chat size budget follows Engram (MIT).
- The bundled MCP SDK is MIT licensed.
- Attribution ships inside the bundle as `ATTRIBUTION.md`.

## Future updates

- **View memory button:** a Marketplace button to view or edit saved memories.
- **Dates on facts**, to help spot stale ones (memory hygiene, see DreamBench-SWE).
- **Automatic memory:** summarize chats in the background, as Claude Code does. VibeMemBench shows this
  must be measured, because most automatic systems didn't help.
- **opencode v2:** memory loading already works in v2 with no change
  (`packages/core/src/mcp/instructions.ts`). When we move, set `codemode: false` on this server so
  `save_memory` stays a simple direct tool.
- **Measure it** with a Qwen test bench: steps, file reads and solved tasks with memory on and off.
