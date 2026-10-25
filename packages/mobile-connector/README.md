# BharatCode mobile connector

This package runs in Desktop main and connects the existing authenticated Desktop sidecar to BharatCode Mobile through `https://tunnel.bharatcode.ai`. It never starts another agent.

In Desktop, open **Settings → Mobile devices → Connect phone**. First-time HTTPS certificate issuance may take a few minutes; progress is shown and startup can be cancelled. Scan, paste or open the pairing link in the native Mobile app, compare the six-digit confirmation on both screens, then approve on Desktop. A link contains only public connection metadata and does not grant access.

The same tunnel identity/certificate and approved phones are restored on subsequent launches. Turn off remote access to disconnect and prevent automatic startup. Revoke a phone to invalidate its credential and terminate its active streams. Reset revokes every phone and removes the hosted tunnel identity; server deletion must succeed before private tunnel state is discarded.

The service-specific `mobile-access/tunnel-bharatcode-ai` store avoids reusing upstream OpenTunnel credentials. Existing upstream Mobile connections require fresh pairing with the new service. No account login is required.

Run source tests from this directory with Node >=22:

```sh
npm test
```

The package's declared SDK dependencies are managed by the root Bun workspace lockfile. Read [the trust boundary](../../docs/mobile-access-trust-boundary.md) before adding routes or changing authentication. Runtime qualification and platform limits are recorded in the associated PR; passing source tests alone does not establish native/device coverage.
