# Desktop previous-chat compatibility

The owner explicitly requested automatic chat import after testing the startup
fix. This supersedes the earlier proposal for a manual chat-import action; it
does not restore the old startup recovery gate or capability/config migration.

- The app/server becomes healthy first. An isolated, bounded utility process
  then checks the previous **same-channel BharatCode** data directory.
- Existing session IDs and project records win. Only absent chats are inserted.
  Credentials, account configuration, marketplace choices, permission rules,
  pending execution, sharing links and project commands are not imported.
- Legacy messages/parts remain intact, with validated new-interface projections
  for text, reasoning, tool history, attachments and model/agent changes.
- Source SQLite is opened read-only, including committed WAL content. A SQLite
  backup of the destination is saved inside its private data directory before
  import. All inserted history and the completion receipt share one transaction.
- A completed source is skipped on later launches; a failed transaction can
  retry on the next launch. Unsupported/corrupt/locked sources cannot become an
  app-readiness barrier. Status appears in a small dismissible banner; successful
  import offers a view refresh without restarting the server.
- This is local-profile compatibility, not a security boundary against another
  process running as the same OS user. It does not move/delete the old database.
- Custom `OPENCODE_DB` destinations and other release channels are not imported.

Also corrected the renderer's BharatCode beta channel and reused the existing
BharatCode logo in the new-session wordmark. No visual redesign or CI gate added.

## Verification

- Real Node SQLite synthetic checks: preserve current sessions/projects,
  transcript/tool conversion, transitional switch IDs, WAL reads, idempotency,
  pre-import backup, malformed-data rollback/retry, same-file/missing/link cases.
- Compiled background-worker check with an isolated home: first import and
  second-launch skip pass. No real profile or network identity involved.
- Windows Node validation on the previously protected **copy**, not the live
  databases: 26 sessions, 841 messages, 2,653 parts, 890 validated projections.
  Source-copy SHA-256 unchanged. No transcript contents logged.
- Desktop/App typecheck and beta Electron production build pass locally.
- Matching installer/manual UI acceptance remains separate and pending.
