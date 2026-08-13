# froe

Push selected logs from your service to a Froe instance. Clients and agents
fetch them back with a read key over a plain REST API.

## Install

```
npm install froe
```

Requires Node 18+ (uses the built-in `fetch`). Zero runtime dependencies.

## Quickstart

```typescript
import { Froe } from "froe";

const log = new Froe({ key: "fw_..." });

log.info("payment ok", { order: 42 });
log.warn("retrying payment", { order: 42, attempt: 2 });
log.error("payment failed", { order: 42, code: "card_declined" });

// In your shutdown hook, flush whatever is still buffered:
await log.flush();
```

All six level methods take a message and an optional meta object:
`trace`, `debug`, `info`, `warn`, `error`, `fatal`.

```typescript
log.trace("cache miss", { key: "user:42" });
log.debug("computed price", { cents: 1999 });
log.fatal("out of memory, exiting");
```

## Constructor options

```typescript
new Froe({
  key: "fw_...",              // required, write key
  url: "https://froe.run",    // your Froe instance
  batchSize: 50,               // flush after this many buffered entries
  flushIntervalMs: 2000,       // or after this many ms, whichever first
  maxBufferedEntries: 10000,   // buffer ceiling; oldest entries drop past it
  fetch: myFetch,               // custom fetch, mainly useful in tests
});
```

Only `key` is required; every other option has the default shown above.

## Delivery guarantees

`log()` calls never throw and never block the caller. Entries are buffered
in memory and sent as a batch when the buffer reaches `batchSize`, when
`flushIntervalMs` elapses, or when you call `flush()`. A failed send retries
twice with backoff, then the batch is dropped with a `console.warn`.

An entry whose message plus meta exceeds 64 KB, or whose meta cannot be
JSON-serialized (for example a circular reference), is dropped at the call
site with a warning; it never enters the buffer. If entries pile up faster
than they can be sent, the buffer keeps at most `maxBufferedEntries` and
drops the oldest ones.

In short: logs are telemetry, not durable storage. Nothing here is meant to
replace your application's own logging or an audit trail.

## Pino transport

```typescript
import pino from "pino";

const logger = pino({
  transport: {
    target: "froe/pino",
    options: { key: "fw_...", url: "https://froe.run" },
  },
});

logger.info("just a local log line");
logger.child({ froe: true }).info("shipped to Froe");
logger.info({ froe: true }, "also shipped to Froe");
```

By default only records carrying `froe: true` are forwarded, whether set on
a child logger or passed per call. A severity level is not a sharing
decision: your `error` logs are not automatically things you want a client
outside your trust boundary to read. Set `forwardAll: true` in the options
to forward the whole stream instead.

Pino levels map 1:1 onto Froe levels (`trace` through `fatal`).

Transport options: `key` (required), `url` (default `https://froe.run`),
`forwardAll` (default `false`), and `fetch` (test seam).

## Reading logs

Consumers with a read key fetch entries with `GET /v1/logs` on your Froe
instance, filtering by `level`, `since`, `until`, `q` (substring match), and
paging with `limit` and `cursor`. The full wire contract, including request
and response shapes, is served at `GET /v1` on any Froe instance.

## Server-side limits

A Froe instance accepts at most 1000 entries per push batch and 64 KB per
entry (message plus meta). The SDK chunks large flushes into batches of at
most 1000 automatically; the per-entry limit is enforced at `log()` time as
described above.
