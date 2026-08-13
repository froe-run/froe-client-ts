import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Froe } from "./index.js";

type Sent = { url: string; init: RequestInit };

function stubFetch(sent: Sent[], status = 202) {
  return vi.fn(async (url: any, init: any) => {
    sent.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: 1 }), { status });
  }) as unknown as typeof globalThis.fetch;
}

function sentEntries(s: Sent): any[] {
  return JSON.parse(String(s.init.body)).entries;
}

describe("Froe core", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("buffers one entry per level method with correct fields", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    log.trace("t"); log.debug("d"); log.info("i", { a: 1 });
    log.warn("w"); log.error("e"); log.fatal("f");
    await log.flush();
    expect(sent).toHaveLength(1);
    const entries = sentEntries(sent[0]);
    expect(entries.map((e: any) => e.level)).toEqual([
      "trace", "debug", "info", "warn", "error", "fatal",
    ]);
    expect(entries[2]).toMatchObject({ message: "i", meta: { a: 1 } });
    expect(entries[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sent[0].url).toBe("http://x/v1/logs");
    expect((sent[0].init.headers as any).authorization).toBe("Bearer fw_k");
  });

  it("flushes on its own when the buffer reaches batchSize", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", batchSize: 3, fetch: stubFetch(sent) });
    log.info("1"); log.info("2");
    expect(sent).toHaveLength(0);
    log.info("3");
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(sentEntries(sent[0])).toHaveLength(3);
  });

  it("flushes on the interval", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", flushIntervalMs: 2000, fetch: stubFetch(sent) });
    log.info("1");
    await vi.advanceTimersByTimeAsync(2100);
    expect(sent).toHaveLength(1);
  });

  it("flush() drains everything and resolves", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    log.info("1"); log.info("2");
    await log.flush();
    expect(sentEntries(sent[0])).toHaveLength(2);
    await log.flush(); // empty flush is a no-op, not an error
    expect(sent).toHaveLength(1);
  });

  it("splits a flush into chunks of at most 1000 entries", async () => {
    const sent: Sent[] = [];
    // batchSize above the entry count so nothing auto-flushes early.
    const log = new Froe({ key: "fw_k", url: "http://x", batchSize: 5000, fetch: stubFetch(sent) });
    for (let i = 0; i < 1500; i++) log.info(`m${i}`);
    await log.flush();
    expect(sent).toHaveLength(2);
    expect(sentEntries(sent[0])).toHaveLength(1000);
    expect(sentEntries(sent[1])).toHaveLength(500);
  });
});
