# Project memory

Project memory lets the model remember facts about a project across chats, such as "this project uses
Bun, not npm" or "tests live in packages/x/test". Each new chat starts already knowing them instead of
re-reading files. It works with any model that can call tools, including Qwen and DeepSeek.

## How it works

- **Three tools:**
  - `save_memory(fact)` saves one short sentence, when the user asks the model to remember something or
    when it learns a lasting project convention.
  - `update_memory(number, fact)` corrects a fact.
  - `forget_memory(number)` removes one.

  Corrected and removed facts move to an "Archived facts" section with a date. They stay in the file
  for the user, but they are not sent to the model.

- **One private file per project:** `<data>/memory/<project-id>/MEMORY.md`. It lives in BharatCode's
  data folder, never in the user's repo, and it is plain Markdown the user can open and edit. Only a
  shortened path (`~/…`) is shown to the model, so the user's account name isn't sent to the model
  provider.
- **Loaded into every chat automatically, including chats started after a save.** MCP clients read a
  server's instructions only once, when they connect. They re-read its tool list whenever the server
  says it changed. So the saved facts, numbered, live in the `save_memory` tool description, and the
  server sends `tools/list_changed` after every change. A fact saved in one chat appears in the next
  chat without restarting the app.
- **Size-limited (`MEMORY.md` only):** the newest saved facts load, up to 4,000 UTF-8 bytes (about
  1,000 tokens). Bytes are counted, not characters, so Hindi and other Indic text stays within budget
  too. This limit doesn't touch `AGENTS.md`, which BharatCode already loads in full, as before.
  **Why 1,000 tokens:** memory is sent with every request, so it must stay small, but 1,000 tokens
  still holds about 40–60 facts, a fraction of a percent of Qwen 3.8 27B's or DeepSeek V4.1 Flash's
  context window. There's no published optimum for these models, so this follows Engram's ~1,024-token
  budget, stays under Anthropic's ~200-line advice for `CLAUDE.md`, and can be raised later if real use
  shows projects need more.
- **Memory never overrules the project's rules.** The model is told that `AGENTS.md`, the user's
  instructions and the actual code always win over a remembered fact, because a saved fact can be out
  of date.
- **Same project, same memory.** Memory is keyed by BharatCode's project ID, so every clone and git
  worktree of a repo shares it. Folders without git get their own memory.
- **Shipped through the Marketplace** as "Project memory": bundled, but **off by default**. Users turn
  it on with one click (Install) and can turn it off again. It is a small MCP server that runs on the app's own runtime, so users don't need
  Node.js installed.

Code:

- `packages/opencode/src/bharatcode/memory.ts`: memory logic
- `packages/opencode/src/bharatcode/memory-server.ts`: MCP server
- `packages/opencode/script/bundle-memory-server.ts`: builds `packages/core/src/capabilities/memory-server.json`
- `packages/core/src/capabilities.ts`: Marketplace wiring

Rebuild the bundle after changing either `memory*.ts` file.

## Safety rules for saving

- One line, at most 500 characters, and not empty.
- Exact duplicates are skipped, for saves and for updates.
- The file is replaced in one step on every change, so a crash never leaves it half-written.
- Text that looks like a secret (API keys, tokens, private keys) is refused.
- A save only counts when the tool actually writes the file, and the tool's reply confirms it.

## Why this design

### What other coding agents do

| Agent       | Rules people write           | Facts the agent saves                                                                                                                                                                                                                 |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `CLAUDE.md` in the repo      | Private per project: `~/.claude/projects/<project>/memory/MEMORY.md`, loaded each chat                                                                                                                                                |
| Qwen Code   | `QWEN.md`                    | A `save_memory` tool appending to `~/.qwen/QWEN.md`. Newer versions add opt-in "Managed Auto-Memory": background extraction after each conversation, plus consolidation ("Dream"), into `~/.qwen/projects/<project>/memory/MEMORY.md` |
| Codex       | `AGENTS.md`                  | Private per user, off by default                                                                                                                                                                                                      |
| Cursor      | `.cursor/rules`, `AGENTS.md` | Removed its memories in 2.1 (Nov 2025)                                                                                                                                                                                                |

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

## How it is tested

**Automated tests:**

- `packages/opencode/test/bharatcode/memory.test.ts` covers:
  - saving, updating and forgetting facts
  - duplicates and secrets
  - the byte budget, including Hindi
  - the shortened path
  - project and worktree keys
- `packages/core/test/capabilities.test.ts` starts the real bundled server and checks:
  - a saved fact reaches the same open connection and a new one
  - parallel saves lose nothing
  - turning the capability off removes it

**Manual testing in the app, with BharatCode's Qwen:**

1. Check that "Project memory" is not enabled in the Marketplace by default. Click Install, then
   Reload runtime.
2. In one chat, ask the model to remember a fact.
3. Start a new chat without restarting, and check it already knows the fact.
4. Correct the fact, then forget it, and check new chats follow each change.
5. Save a Hindi fact.
6. Check that a secret is refused.
7. Open `MEMORY.md`, then turn the capability off in the Marketplace.

**Why manual testing and not a benchmark:**

- **It answers the question that matters first.** Does memory work end to end, in the real app, with
  our model, on Windows? A benchmark measures _how much_ memory helps. That only makes sense once it
  is known to work.
- **Existing coding-memory benchmarks don't fit this feature yet:**
  - They run the agent in Linux containers, while BharatCode Desktop's main platform is Windows.
  - They are built around other agents (Codex CLI, Claude Code, MiniSWEAgent), so BharatCode would
    need its own adapter first.
  - Most of them test memory built automatically from past runs. This feature tests facts the model
    chooses to save.
  - A memory on/off comparison takes hundreds of sessions, which is costly to repeat for every change.
- **It is quick to repeat:** the checks above take minutes and need no extra setup.

A benchmark becomes worth it when the future updates below are compared against each other.

## Future updates

- **Two levels inside saved memory:** a short `MEMORY.md` index that always loads, plus topic files the
  model reads only when needed, as Claude Code does. That lets memory grow without growing every prompt.
  This is different from the two *layers* we already have: `AGENTS.md`, written by people, and
  `MEMORY.md`, written by the model. Both of those load in full on every request.
- **A topic and date on each saved fact.** Archived facts are already dated.
- **Near-duplicate check:** today only exact duplicates are caught.
- **View memory button:** a Marketplace button to view or edit saved memories.
- **Token-aware budget:** the budget counts characters, so Hindi and other non-Latin text can cost more tokens than intended.
- **Shared lessons with `/learn`:** ship opencode's `/learn` command (MIT) through the Marketplace so people can turn a session's non-obvious lessons into reviewed `AGENTS.md` entries for the whole team.
- **View memory button:** a Marketplace button to view or edit saved memories.
- **Automatic memory:** summarize chats in the background, as Claude Code and Qwen Code's Managed
  Auto-Memory do. This costs an extra model call per chat, and research shows most automatic memory
  systems didn't help, so it would need measuring first.
- **opencode v2:** memory loading already works in v2 with no change
  (`packages/core/src/mcp/instructions.ts`). When we move, set `codemode: false` on this server so
  the memory tools stay simple direct tools and the model can see their fact list.
