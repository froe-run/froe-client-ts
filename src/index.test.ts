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

describe("Froe resilience", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries twice on network failure, then drops with one console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("doomed");
    const flushing = log.flush();
    await vi.runAllTimersAsync(); // advance through both backoffs
    await flushing;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_bad", url: "http://x", fetch: fetchFn });
    log.info("rejected");
    await log.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps working after a dropped batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const sent: any[] = [];
    const fetchFn = vi.fn(async (url: any, init: any) => {
      if (fail) throw new Error("down");
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("lost");
    const flushing = log.flush();
    await vi.runAllTimersAsync();
    await flushing;
    fail = false;
    log.info("delivered");
    await log.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].entries[0].message).toBe("delivered");
  });

  it("never throws, even with circular meta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch([]) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info("odd", circular)).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // the batch was dropped, loudly once
  });

  it("never throws when fetch itself is broken", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new Froe({
      key: "fw_k",
      url: "http://x",
      fetch: (() => {
        throw new Error("sync explosion");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(() => log.info("x")).not.toThrow();
    const flushing = log.flush();
    await vi.runAllTimersAsync();
    await expect(flushing).resolves.toBeUndefined();
  });
});
