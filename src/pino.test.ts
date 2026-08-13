import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import froeTransport from "./pino.js";

function stub() {
  const sent: any[] = [];
  const fetchFn = vi.fn(async (_url: any, init: any) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 202 });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetchFn };
}

// Writes NDJSON lines the way pino does over a transport stream, then ends
// the stream so the transport's final flush runs.
async function run(stream: NodeJS.WritableStream, lines: object[]) {
  for (const l of lines) stream.write(JSON.stringify(l) + "\n");
  stream.end();
  await once(stream, "close");
}

const REC = {
  level: 30,
  time: 1755079923000,
  pid: 7,
  hostname: "h",
  msg: "payment ok",
};

describe("froe pino transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards only records marked froe: true by default", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", fetch: fetchFn });
    await run(stream, [
      { ...REC, msg: "internal detail" },
      { ...REC, froe: true, msg: "shared event" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].entries).toHaveLength(1);
    expect(sent[0].entries[0].message).toBe("shared event");
  });

  it("forwards everything with forwardAll: true", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", forwardAll: true, fetch: fetchFn });
    await run(stream, [{ ...REC }, { ...REC, froe: true }]);
    expect(sent[0].entries).toHaveLength(2);
  });

  it("maps pino numeric levels to froe levels", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", forwardAll: true, fetch: fetchFn });
    await run(stream, [10, 20, 30, 40, 50, 60].map((level) => ({ ...REC, level })));
    expect(sent[0].entries.map((e: any) => e.level)).toEqual([
      "trace", "debug", "info", "warn", "error", "fatal",
    ]);
  });

  it("carries pino's timestamp and extra bindings as meta, dropping noise fields", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", fetch: fetchFn });
    await run(stream, [{ ...REC, froe: true, orderId: 42, region: "eu" }]);
    const e = sent[0].entries[0];
    expect(e.time).toBe(new Date(REC.time).toISOString());
    expect(e.meta).toEqual({ orderId: 42, region: "eu" });
  });

  it("omits meta when only standard fields exist", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", fetch: fetchFn });
    await run(stream, [{ ...REC, froe: true }]);
    expect(sent[0].entries[0].meta).toBeUndefined();
  });

  it("survives partial lines split across writes and garbage lines", async () => {
    const { sent, fetchFn } = stub();
    const stream = froeTransport({ key: "fw_k", url: "http://x", fetch: fetchFn });
    const line = JSON.stringify({ ...REC, froe: true }) + "\n";
    stream.write(line.slice(0, 10));
    stream.write(line.slice(10));
    stream.write("not json at all\n");
    stream.end();
    await once(stream, "close");
    expect(sent).toHaveLength(1);
    expect(sent[0].entries).toHaveLength(1);
  });
});
