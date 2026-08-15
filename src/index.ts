// batchKey generates the per-batch Idempotency-Key. No Node builtin may
// be imported here: the browser demo loads dist/index.js as a native ES
// module, so a node: specifier would kill the whole module at import
// time. The key only has to be unique per app for the server's 24 hour
// window, not cryptographically strong, so where crypto.randomUUID is
// missing (Node 18 without the webcrypto flag, browsers outside a
// secure context) a timestamp-plus-Math.random string is enough.
function batchKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface FroeOptions {
  key: string;
  url?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  // Ceiling on entries held in memory, counting the unformed buffer and
  // the batches waiting in the retry queue together, so a single number
  // bounds the SDK's whole footprint. Past it the oldest entries go
  // first: whole batches from the queue head, then the oldest buffer
  // entries.
  maxBufferedEntries?: number;
  // Per-attempt cap on how long a send may hang before it is aborted and
  // treated as a failed attempt. Without this, a server that accepts the
  // connection but never responds ties up an in-flight request for
  // Node's undici default (~5 minutes), and because the head batch
  // blocks the queue, nothing else would ship until it settled.
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface Entry {
  time: string;
  level: Level;
  message: string;
  meta?: Record<string, unknown>;
}

// A formed batch is frozen at formation time: its Idempotency-Key and
// exact serialized body never change across retries, because the server's
// replay detection hashes the raw body. Re-forming a failed batch with
// newer entries under a new key would double-store entries whose
// original 202 was lost in transit.
interface FormedBatch {
  key: string;
  body: string;
  count: number;
}

// The outcome of one attempt on the head batch, classified here so the
// send loop stays a plain policy table: shift and move on, drop and move
// on, or keep the batch and back off.
type Outcome =
  | { kind: "sent" }
  | { kind: "drop"; status: number }
  | { kind: "retry"; retryAfterMs?: number };

// Server-side limit on entries per POST /v1/logs; see API.md.
const MAX_BATCH = 1000;

// Server-side limit on message+meta bytes per entry; see API.md. Entries
// over this are quarantined at log() time so one bad entry never poisons
// an otherwise-good batch (the server rejects a batch whole on one bad
// entry).
const MAX_ENTRY_BYTES = 64 * 1024;

// Exponential backoff for a failing head batch: BASE * 4^failures, capped
// so a long outage settles into a retry every 30 seconds instead of
// backing off toward hours.
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;

// Shared across log() calls; constructing a TextEncoder per call would be
// pure waste for something with no per-instance state.
const encoder = new TextEncoder();

export class Froe {
  private buffer: Entry[] = [];
  // Formed batches waiting to be sent, strictly FIFO. Only the head is
  // ever attempted: the server orders entries by ingestion, so sending
  // batch 2 before batch 1 lands would interleave history.
  private queue: FormedBatch[] = [];
  private timer?: ReturnType<typeof setInterval>;
  // Consecutive failed attempts on the head batch; drives the backoff.
  private failures = 0;
  // Epoch ms before which a timer tick must not attempt a send. Explicit
  // flush() ignores this gate: a shutdown hook must not wait out a 30
  // second backoff.
  private nextAttemptAt = 0;
  // The one in-flight pass. Concurrent flush() calls and timer ticks
  // await it instead of racing a second send of the same head batch.
  private activePass?: Promise<void>;
  private readonly key: string;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedEntries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  // Set on the first drop of an overflow episode, cleared once a send
  // succeeds, so a host stuck offline gets one warning, not one per entry.
  private overflowWarned = false;

  constructor(opts: FroeOptions) {
    this.key = opts.key;
    this.url = (opts.url ?? "https://froe.run").replace(/\/$/, "");
    this.batchSize = opts.batchSize ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    // ponytail: 10000 is the memory ceiling across buffer plus retry
    // queue; past it we drop the oldest entries rather than let an
    // offline host grow without bound.
    this.maxBufferedEntries = opts.maxBufferedEntries ?? 10000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  trace(message: string, meta?: Record<string, unknown>): void { this.log("trace", message, meta); }
  debug(message: string, meta?: Record<string, unknown>): void { this.log("debug", message, meta); }
  info(message: string, meta?: Record<string, unknown>): void { this.log("info", message, meta); }
  warn(message: string, meta?: Record<string, unknown>): void { this.log("warn", message, meta); }
  error(message: string, meta?: Record<string, unknown>): void { this.log("error", message, meta); }
  fatal(message: string, meta?: Record<string, unknown>): void { this.log("fatal", message, meta); }

  // time exists for adapters that carry the host logger's timestamp.
  log(level: Level, message: string, meta?: Record<string, unknown>, time?: string): void {
    try {
      // ponytail: stringifying meta here to size it, and again at batch
      // formation, is double work; it buys per-entry quarantine instead
      // of having one bad entry (circular meta, an oversized blob) sink a
      // whole batch.
      let metaJSON = "";
      if (meta !== undefined) {
        try {
          metaJSON = JSON.stringify(meta);
        } catch {
          console.warn("froe: dropped one entry, meta is not JSON-serializable (e.g. circular reference)");
          return;
        }
      }
      const size = encoder.encode(message).length + encoder.encode(metaJSON).length;
      if (size > MAX_ENTRY_BYTES) {
        console.warn(`froe: dropped one entry, ${size} bytes exceeds the ${MAX_ENTRY_BYTES} byte per-entry limit`);
        return;
      }

      this.buffer.push({ time: time ?? new Date().toISOString(), level, message, meta });
      // One knob bounds memory: buffered entries plus queued batch
      // entries together. Queued batches at the head hold the oldest
      // entries, so whole batches go first, then the oldest buffer
      // entries, until back under the cap.
      let held = this.buffer.length + this.queuedEntryCount();
      if (held > this.maxBufferedEntries) {
        while (held > this.maxBufferedEntries && this.queue.length > 0) {
          held -= this.queue.shift()!.count;
        }
        if (held > this.maxBufferedEntries) {
          this.buffer.splice(0, held - this.maxBufferedEntries);
        }
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          console.warn(`froe: held entries exceeded ${this.maxBufferedEntries}; dropped oldest`);
        }
      }
      if (this.buffer.length >= this.batchSize) {
        // A full buffer is a send trigger, not a shutdown, so it goes
        // through the backoff gate rather than around it like flush().
        // Without the gate a hot logger attempts the failing head batch
        // every batchSize entries, defeating the backoff (and the
        // server's Retry-After) exactly when the server is under most
        // pressure. The batch is still formed and queued; the interval
        // ships it once the gate opens.
        void this.pass(false).catch(() => {});
      } else {
        this.syncTimer();
      }
    } catch {
      // Log calls never throw; a logging SDK must not break its host.
    }
  }

  // One ordered pass, not a drain-until-empty loop: form batches, then
  // send from the head until the queue is empty or one send fails. On
  // failure it resolves anyway, leaving the queue intact for the next
  // interval tick, so a shutdown hook is never held hostage by a backoff
  // or a dead server.
  async flush(): Promise<void> {
    try {
      await this.pass(true);
    } catch {
      // flush never rejects; failures leave the queue for the next tick.
    }
  }

  private async pass(ignoreGate: boolean): Promise<void> {
    this.formBatches();
    // Joining a pass that is already past its send loop (its finally has
    // not cleared activePass yet) would resolve without attempting the
    // batch formed above; a shutdown hook's await flush() would then
    // strand that batch even with the server up. So after a joined pass
    // settles, loop and run a fresh pass of our own when work remains.
    while (this.activePass) {
      await this.activePass;
    }
    // The backoff gate applies to timer ticks only; an explicit flush()
    // ignores it, because a shutdown hook must not wait out a backoff.
    if (this.queue.length === 0 || (!ignoreGate && Date.now() < this.nextAttemptAt)) {
      this.syncTimer();
      return;
    }
    this.activePass = this.sendPass().finally(() => {
      this.activePass = undefined;
      this.syncTimer();
    });
    await this.activePass;
  }

  // Drains the entry buffer into frozen batches. This is the only place
  // a batch (and its idempotency key) is born; from here on the batch is
  // immutable for its whole life.
  private formBatches(): void {
    while (this.buffer.length > 0) {
      const entries = this.buffer.splice(0, MAX_BATCH);
      let body: string;
      try {
        body = JSON.stringify({ entries });
      } catch {
        // Per-entry quarantine at log() time makes this nearly
        // unreachable, but a meta getter can change behavior between
        // calls; dropping the chunk beats poisoning the queue head.
        console.warn(`froe: dropped ${entries.length} entries with unserializable meta`);
        continue;
      }
      this.queue.push({ key: batchKey(), body, count: entries.length });
    }
  }

  private async sendPass(): Promise<void> {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const outcome = await this.attempt(head);
      if (outcome.kind === "retry") {
        const backoff = Math.min(BASE_BACKOFF_MS * 4 ** this.failures, MAX_BACKOFF_MS);
        this.failures += 1;
        this.nextAttemptAt = Date.now() + (outcome.retryAfterMs ?? backoff);
        return;
      }
      // Remove by identity, not a blind shift: an overflow eviction in
      // log() may have removed this batch while its request was in
      // flight.
      const idx = this.queue.indexOf(head);
      if (idx !== -1) this.queue.splice(idx, 1);
      if (outcome.kind === "drop") {
        // An overflow-evicted batch already got its one warn; do not
        // warn a second time when its in-flight request comes back 4xx.
        if (idx !== -1) console.warn(`froe: dropped ${head.count} entries (status ${outcome.status})`);
      } else {
        this.overflowWarned = false;
      }
      this.failures = 0;
      this.nextAttemptAt = 0;
    }
  }

  private async attempt(batch: FormedBatch): Promise<Outcome> {
    try {
      const res = await this.fetchFn(`${this.url}/v1/logs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.key}`,
          // Held constant across every retry of this batch so a retry
          // whose original 202 was lost in transit replays instead of
          // storing the entries twice (see API.md, Idempotency-Key).
          "idempotency-key": batch.key,
        },
        body: batch.body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (res.ok) return { kind: "sent" };
      if (res.status === 429) {
        // Rate limiting is retryable, never a drop. Retry-After is
        // integer seconds; anything missing or unparsable falls back to
        // the normal exponential backoff. The value is capped at the
        // same 30 second ceiling as the backoff, so a huge or bogus
        // header (86400, or digits overflowing to Infinity) cannot gate
        // the queue for a day or forever.
        const header = res.headers.get("retry-after")?.trim();
        const retryAfterMs = header && /^\d+$/.test(header)
          ? Math.min(Number(header) * 1000, MAX_BACKOFF_MS)
          : undefined;
        return { kind: "retry", retryAfterMs };
      }
      // Any other 4xx means the request itself is wrong; no retry can
      // fix it, so the batch is dropped rather than blocking the queue.
      if (res.status >= 400 && res.status < 500) return { kind: "drop", status: res.status };
      return { kind: "retry" };
    } catch {
      // Network error or timeout; the batch stays at the head.
      return { kind: "retry" };
    }
  }

  private queuedEntryCount(): number {
    let n = 0;
    for (const b of this.queue) n += b.count;
    return n;
  }

  // The flush interval is the only scheduler: it runs while either the
  // buffer or the queue holds anything, and clears only when both are
  // empty, so a failed batch keeps getting retried without a second
  // timer.
  private syncTimer(): void {
    const pending = this.buffer.length > 0 || this.queue.length > 0;
    if (pending && !this.timer) {
      this.timer = setInterval(() => void this.pass(false), this.flushIntervalMs);
      // Never keep the host process alive just to ship logs.
      (this.timer as any).unref?.();
    } else if (!pending && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
