export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface FroeOptions {
  key: string;
  url?: string;
  batchSize?: number;
  flushIntervalMs?: number;
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

export class Froe {
  private buffer: Entry[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly key: string;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: FroeOptions) {
    this.key = opts.key;
    this.url = (opts.url ?? "https://froe.run").replace(/\/$/, "");
    this.batchSize = opts.batchSize ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
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
      this.buffer.push({ time: time ?? new Date().toISOString(), level, message, meta });
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
        });
        if (res.ok) return;
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
