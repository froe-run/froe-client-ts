export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface FroeOptions {
  key: string;
  url?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  // Ceiling on in-memory buffered entries; a host that logs faster than it
  // can flush drops its oldest entries rather than growing without bound.
  maxBufferedEntries?: number;
  // Per-attempt cap on how long a send may hang before it is aborted and
  // treated as a failed attempt. Without this, a server that accepts the
  // connection but never responds ties up an in-flight request for
  // Node's undici default (~5 minutes), and because flushes are not
  // re-entrancy guarded, steady logging can pile up one such hang per
  // flush tick.
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface Entry {
  time: string;
  level: Level;
  message: string;
  meta?: Record<string, unknown>;
}

// Server-side limit on entries per POST /v1/logs; see API.md.
const MAX_BATCH = 1000;

// Server-side limit on message+meta bytes per entry; see API.md. Entries
// over this are quarantined at log() time so one bad entry never poisons
// an otherwise-good batch (the server rejects a batch whole on one bad
// entry).
const MAX_ENTRY_BYTES = 64 * 1024;

// Shared across log() calls; constructing a TextEncoder per call would be
// pure waste for something with no per-instance state.
const encoder = new TextEncoder();

export class Froe {
  private buffer: Entry[] = [];
  private timer?: ReturnType<typeof setInterval>;
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
    // ponytail: 10000 is the buffer ceiling; past it we drop the oldest
    // entries rather than let an offline host grow this without bound.
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
      // ponytail: stringifying meta here to size it, and again in send(),
      // is double work; it buys per-entry quarantine instead of having one
      // bad entry (circular meta, an oversized blob) sink a whole batch.
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
      if (this.buffer.length > this.maxBufferedEntries) {
        this.buffer.splice(0, this.buffer.length - this.maxBufferedEntries);
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          console.warn(`froe: buffer exceeded ${this.maxBufferedEntries} entries; dropped oldest`);
        }
      }
      if (this.buffer.length >= this.batchSize) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
        // Never keep the host process alive just to ship logs.
        (this.timer as any).unref?.();
      }
    } catch {
      // Log calls never throw; a logging SDK must not break its host.
    }
  }

  async flush(): Promise<void> {
    try {
      if (this.buffer.length === 0) {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        return;
      }
      while (this.buffer.length > 0) {
        await this.send(this.buffer.splice(0, MAX_BATCH));
      }
    } catch {
      // flush never rejects; failures were already handled in send.
    }
  }

  private async send(entries: Entry[]): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify({ entries });
    } catch {
      console.warn(`froe: dropped ${entries.length} entries with unserializable meta`);
      return;
    }
    let attempts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      attempts++;
      try {
        const res = await this.fetchFn(`${this.url}/v1/logs`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.ok) {
          this.overflowWarned = false;
          return;
        }
        // 4xx means the request itself is wrong; retrying cannot fix it.
        if (res.status >= 400 && res.status < 500) break;
      } catch {
        // Network error; fall through to the backoff and retry.
      }
      if (attempt < 2) await sleep(250 * 4 ** attempt);
    }
    console.warn(`froe: dropped ${entries.length} entries (${attempts} attempts)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
