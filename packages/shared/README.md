# `@pilot/shared`

The single source of truth for the wire contract between `pilot-cli` and `pilot-app`.

It contains:

- Zod schemas for the REST endpoints (`/api/health`, `/api/fs`, `/api/tools`)
  and the WebSocket handshake (`/ws/pty`).
- TypeScript types inferred from the schemas.
- Constants (`PROTOCOL_VERSION`, `DEFAULT_PORT`, route paths, the
  `pilot://` pairing scheme).

## When to bump `PROTOCOL_VERSION`

Any time you change a schema in a way that's not backwards-compatible
(rename a field, change a type, add a required field). The `version`
literal in `PairingPayloadSchema` will then force a manual QR re-pair
rather than silently mis-parsing.

## Tests

```bash
pnpm --filter @pilot/shared test
```
