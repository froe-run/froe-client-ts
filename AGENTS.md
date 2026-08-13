# sdk/typescript/ agent guide

What differs from the root guide when working in the TypeScript SDK. Read
the root `AGENTS.md` first.

## Shape

- Package `froe`. Zero runtime dependencies; Node 18+ built-in `fetch`.
  Adding a dependency is a design decision, not a convenience.
- The hard rule of this package: log calls never throw and never block the
  host application. Failures buffer, retry twice with backoff, then drop
  with one `console.warn`. Any change must preserve this property; there is
  a test asserting it.
- Buffering: in-memory, flushed as one `POST /v1/logs` batch at the size or
  interval threshold, and on `flush()`. `API.md` is the contract; do not
  invent fields the server does not accept.
- Logger adapters (e.g. pino) live as subpath exports (`froe/pino`), map
  the host lib's record shape onto Froe entries, and feed the same buffer.
  They stay thin; policy (level mapping, filtering) is explicit options,
  not magic.

## Verify

    npm run build && npm test

`tsc` for types, `vitest` with a stubbed `fetch` for behavior. Nothing may
need the network or a running server.
