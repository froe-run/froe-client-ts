# froe-client-ts agent guide

A guide for AI-assisted development of this repo, whatever harness is
reading it. This is the TypeScript SDK for Froe, the log-sharing service:
developers push selected logs through this package; clients and agents
fetch them from a Froe instance over REST. The server lives in
`froe-run/backend`; its `API.md` is the wire contract this package
implements, and any Froe instance serves it at `GET /v1`.

## Shape

- Package `froe`. Zero runtime dependencies; Node 18+ built-in `fetch`.
  Adding a dependency is a design decision, not a convenience.
- The hard rule of this package: log calls never throw and never block the
  host application. Failures buffer, retry twice with backoff, then drop
  with one `console.warn`. Oversized entries (64 KB message plus meta) and
  unserializable meta are dropped at the call site. Any change must
  preserve these properties; there are tests asserting them.
- Buffering: in-memory, capped (oldest dropped beyond the cap), flushed as
  one `POST /v1/logs` batch at the size or interval threshold, and on
  `flush()`. Do not invent fields the server does not accept; the contract
  wins over convenience.
- Logger adapters (e.g. pino) live as subpath exports (`froe/pino`), map
  the host lib's record shape onto Froe entries, and feed the same buffer.
  They stay thin; policy (level mapping, marker filtering) is explicit
  options, not magic.

## Verify

    npm run build && npm test

`tsc` for types, `vitest` with a stubbed `fetch` for behavior. Nothing may
need the network or a running server. Never start long-lived processes;
ask the user to run them.

## Conventions

- Comments are full sentences explaining why, not what.
- Tests sit beside the code (`*.test.ts`) and are named as sentences.
- Commits carry no AI co-author trailers, ever. Commit only when asked.
- Pushing and publishing are gated by the user: nothing is pushed, turned
  into a PR, or published to npm until the user asks for it.
- Text style everywhere (code comments, docs, commits): no em dashes, no
  emojis. Use periods, semicolons, colons, commas, or parentheses.
- One change at a time; never fold a refactor into a feature.
- If your change invalidates a line in this file or in `README.md`, fix it
  in the same change.
