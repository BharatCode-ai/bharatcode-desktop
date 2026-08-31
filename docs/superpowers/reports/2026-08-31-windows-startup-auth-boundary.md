# Windows startup: native account-storage correction

This local correction follows startup commits `744ffd60fa` (log creation) and
`23f86a8ec0` (terminal initialization acknowledgement). The exact 23f package
reached a healthy sidecar and opened its main window, then failed on local
`get-account-status` HTTP 503. The Windows default credential verifier rejected
every read, including a missing store. This was not a production API outage.

## Scope and reuse

The preserved lean commit `05113b72f1` supplied the status-resilience approach,
not an unchanged security adapter. No broad lean merge or directory-fsync
suppression was imported. POSIX credential behavior is unchanged. The native
Windows path replaces pathname verification followed by an unrelated read.

The adapter uses the built-in System32 Windows PowerShell/.NET host, with native
handle patterns already used by the Windows ownership controller. No new npm
native dependency is added. Request and response bytes use private process
pipes, not command arguments, environment variables, script files or logs.
The child receives only system/temp environment paths and a bounded timeout.

## Access authority

- Ancestor directories are opened with reparse-point inspection and without
  delete sharing; their handles remain retained until the operation finishes.
- The direct store parent and leaf must be owned by the current Windows SID.
  Effective allow entries are accepted only for that SID, SYSTEM, or local
  Administrators. Those two OS principals are an explicit trusted boundary;
  this does not promise protection against the current user or administrators.
- Everyone, Users, Authenticated Users and other effective principals are
  rejected conservatively. CREATOR OWNER is not independently trusted.
  Inherit-only entries are not effective grants. Null/unsupported DACLs fail.
- `GetSecurityInfo` checks the retained handle. A credential leaf must be a
  regular, single-link, non-reparse file. Reads disallow concurrent write/delete,
  consume that same handle, and recheck parent/leaf security before returning.
- A genuinely missing read returns missing within that native operation. There
  is no later pathname read that could consume a newly appearing unchecked file.
- Existing ACLs are never broadened or silently rewritten. Newly created owned
  directories and temporary files get explicit private current-user/SYSTEM ACLs.

## Publication and uncertainty

The existing cross-process SQLite AuthLock remains held over reread, callback
and publication. Windows publication creates a private file exclusively relative
to the held parent, writes and flushes it, and uses the controller-style
retained-handle `NtSetInformationFile` rename into that held parent. Replacement
uses REPLACE_IF_EXISTS plus POSIX_SEMANTICS so a retained old handle continues to
refer to the old object. The new regular file has FILE_WRITE_THROUGH and is
flushed again after publication; final path, type/link count and ACLs are checked.

This is a tested Windows API/protocol and interruption claim, **not hardware
power-loss certification**. It is not a Windows directory-fsync approximation.
Pre-publication exceptions remove only the owned staging handle and preserve the
previous credential. Post-publication failure or process timeout reports an
unconfirmed operation: it never erases/rolls back the activated record or blindly
replays the refresh callback. A later operation must acquire the lock and reread
current state. POSIX's existing post-rename tail behavior is outside this change.

## User-visible failure

An unavailable local credential store produces a safe, unauthenticated
`connection_issue` status with an explicit local-storage/access/retry message.
It is neither `signed_out` nor a claim of a network/backend outage. Unsafe
redirects and 401/403 errors are not hidden by this status handling.

## Verification and limits

Native tests exercise actual current-user ACL inspection, broad grants on leaf
and parent, hardlinks/junctions, attempted parent/leaf replacement while held,
missing-file appearance, helper timeout, before/after-activation faults, and
private staging cleanup. A compiled shared-Auth worker exercises creation,
rotation and removal across independent processes. Source-level injected fault
points run inside the actual native implementation; they are not production env
switches. Wrong-owner mutation requiring unavailable Windows privileges is not
claimed as exercised. Power-loss and full OS/JIT acceptance remain unverified.

All mutation fixtures use newly created temporary homes. No real account tokens,
profile migration, user Start Fresh, website re-enable or public release occurs.
The fresh packaged main-window check and independent QA review are separate
gates; passing an empty-store screen alone is not usable-auth acceptance.

Two evidence tracks remain distinct. Native adapter/compiled lifecycle tests let
the production adapter create an absent private store beneath an isolated root;
they do not prove the whole application's first-use directory ordering. Packaged
first-use uses ordinary inherited fresh-profile directories without pre-creating
or hardening the app's credential parent. This host's LocalAppData/TEMP have
unrelated effective inherited grants, found by read-only inspection. Those grants
are not allowlisted or edited. A broad existing app-owned parent must reject
credential publication and existing-file consumption with actionable unavailable
status; only a definitely missing no-follow leaf may report signed out. A real
denied open or reparse ancestry must never be classified as missing. Fresh-profile
sign-in acceptance is not cleared by a pre-hardened fixture or missing-store UI.

Fresh local verification before this checkpoint:

- Native Windows adapter plus compiled shared-Auth lifecycle: 17/17, 74 assertions.
- Native Desktop account/initialization tests: 17/17, 76 assertions.
- Linux Desktop source suite: 146/146, 700 assertions.
- Linux existing Auth suite: 46/46, 388 assertions.
- Native OpenCode and Desktop package typechecks: pass.
- Linux typecheck was attempted but its shared dependency cache lacks the
  `@typescript/native-preview-linux-x64` executable; no source/typecheck success
  is claimed from that failed invocation. Native typechecks are the successful
  fresh type evidence. No unrelated dependency cache was changed.
- Formatting and whitespace checks pass. Packaged first-use remains pending.

Native API references: [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[CreateFile sharing/ownership](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
