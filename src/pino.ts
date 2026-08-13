import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Froe, type Level } from "./index.js";

export interface FroePinoOptions {
  key: string;
  url?: string;
  // By default only records carrying `froe: true` (a child binding or a
  // per-call field) are forwarded: a severity level is not a sharing
  // decision. forwardAll restores the firehose for the rare app whose
  // whole stream is meant to be shared.
  forwardAll?: boolean;
  fetch?: typeof globalThis.fetch; // test seam
}

const LEVELS: Record<number, Level> = {
  10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal",
};

// pino record fields that are transport noise, not user meta.
const OMIT = new Set(["level", "time", "msg", "pid", "hostname", "froe"]);

export default function froeTransport(opts: FroePinoOptions): Writable {
  const client = new Froe({ key: opts.key, url: opts.url, fetch: opts.fetch });
  let tail = "";
  // A chunk boundary can land inside a multi-byte UTF-8 character; naive
  // `chunk.toString()` per chunk would decode each half separately and
  // corrupt it. One decoder per transport instance carries pending bytes
  // across writes until a full character is available.
  const decoder = new StringDecoder("utf8");

  function handle(line: string): void {
    try {
      const rec = JSON.parse(line);
      if (!opts.forwardAll && rec.froe !== true) return;
      const meta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (!OMIT.has(k)) meta[k] = v;
      }
      // A host logger configured with `timestamp: false` (or any record
      // missing a numeric time) has no timestamp to carry over; omit it so
      // the core stamps arrival time instead of building an Invalid Date.
      const time = typeof rec.time === "number" && Number.isFinite(rec.time)
        ? new Date(rec.time).toISOString()
        : undefined;
      client.log(
        LEVELS[rec.level] ?? "info",
        typeof rec.msg === "string" ? rec.msg : "",
        Object.keys(meta).length > 0 ? meta : undefined,
        time,
      );
    } catch {
      // A malformed line must never take the transport down.
    }
  }

  return new Writable({
    write(chunk, _enc, cb) {
      tail += decoder.write(chunk);
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") handle(line);
      }
      cb();
    },
    final(cb) {
      tail += decoder.end();
      if (tail.trim() !== "") handle(tail);
      client.flush().then(() => cb(), () => cb());
    },
  });
}
