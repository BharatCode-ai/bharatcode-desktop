# Desktop–Mobile tunnel trust boundary

This integration uses the existing OpenTunnel SDK against `https://tunnel.bharatcode.ai`, reviewed against `bharatcode-tunnel` commit `fe7dfa73b35ebb035ba42a62482ec230a7e1a8bf`, particularly the [client SDK documentation](https://github.com/BharatCode-ai/bharatcode-tunnel/blob/fe7dfa73b35ebb035ba42a62482ec230a7e1a8bf/packages/client/README.md) and [route-target trust boundary](https://github.com/BharatCode-ai/bharatcode-tunnel/blob/fe7dfa73b35ebb035ba42a62482ec230a7e1a8bf/docs/trust-boundary.md). It requires no new account or API/Chat service change.

## Transport and application authority

The relay forwards encrypted application traffic. The SDK terminates tenant TLS in Desktop main and forwards decrypted bytes to a dedicated loopback mobile gateway. The gateway uses a separate private connection credential to access the already-running Desktop sidecar. The sidecar itself, local management endpoints, account credentials, provider secrets and Desktop IPC are never tunnel routes.

A tunnel URL, loopback TCP peer, `Host: localhost`, or any `Forwarded`/`X-Forwarded-*` header grants no authority. The gateway authenticates each application request using a device bearer credential and only forwards its explicit route allowlist. It constructs upstream authorization itself and does not forward visitor cookies, credentials or forwarding headers. Configuration/credential/account endpoints and the global event stream are outside the mobile policy. Selected conversation events and sanitized model metadata are projected by the existing connector.

Desktop management travels through preload IPC. Only an owned renderer's main frame can invoke mobile actions. The renderer never runs the tunnel client or receives the sidecar password, tunnel token/private key, phone bearer token or pending claim secret. Remote revocation cannot be performed through a public management endpoint; a phone can revoke its own credential.

## Pairing and device access

Desktop explicitly opens a five-minute pairing window. Its QR/link contains only a public Desktop identifier and HTTPS tenant origin. A link does not authenticate its holder; pending pairing requests can arrive from anyone who knows the address while that window is open. Desktop shows the phone name and random six-digit confirmation. The owner must compare the code on the phone before approving; phone names alone are untrusted.

The phone posts a claim request over HTTPS. The response contains a fresh high-entropy claim ID and claim secret; polling uses a JSON POST body. Pending claims are bounded to five, with at most ten accepted attempts per minute per Desktop. Refreshing the QR invalidates pending claims; expiry and decline prevent approval. A successful approval closes the pairing window and declines competing waiting requests. The legacy JSON QR's one-use code remains supported, but that code is never encoded into the new link.

Only explicit trusted Desktop approval creates a phone credential. It is delivered once in the HTTPS response body, stored in native SecureStore on Mobile, and represented only by its SHA-256 verifier in the Desktop registry. Subsequent requests and streaming use the authorization header. Credentials and claim secrets are not query parameters, cookies or diagnostic output. Native fetch explicitly omits cookies and refuses redirects. Both clients accept only well-formed HTTPS tenant origins below `tunnel.bharatcode.ai`, rejecting the control apex, upstream service, other domains, credentials, paths, query/fragment, unexpected ports and URL parser normalization tricks. Opened app links accept exactly `origin` and `desktopID` once each.

Revocation removes the verifier and terminates that device's active requests/streams. Further requests receive HTTP 401 and require a new Desktop-approved pairing. Disabling remote access closes the gateway/tunnel, clears pending invitations, and persists the disabled preference. Previously authorized phones remain registered for deliberate re-enablement. Reset additionally revokes every phone and asks the tunnel service to remove the identity; private tunnel state is retained if server removal fails so removal can be retried.

## Persistence and operations

The tunnel token, TLS private key, certificate and pending issuance state stay in the private Desktop user-data tree, outside the renderer. Directories use mode 0700 and SDK secret files use mode 0600 on POSIX; native platform user-data permissions also apply. Mobile bearer credentials are separate from SQLite conversation metadata/drafts. Access tokens, private keys and claim secrets must not appear in support logs, screenshots or PR evidence.

The SDK's cancellable Effect interface keeps status/cancel actions available while issuance waits for DNS/certificate readiness. Pending issuance is resumable. A service-specific `mobile-access/tunnel-bharatcode-ai` store prevents credentials from the old upstream service being sent to the new API. Later starts restore the same tunnel/certificate and phone registry until explicitly disabled or reset. Connectivity state is not proof of an authenticated application request.

AWS, Route 53, Azure and ZeroSSL credentials belong solely to the hosted service. Neither app includes them. Applications continue normal HTTPS certificate validation. Source checks, real hosted tunnel tests, native/emulator tests and physical-device tests are reported as separate evidence tiers; see the dated verification report for actual coverage.
