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

describe("Froe buffer cap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drops oldest entries past maxBufferedEntries, warning once per overflow episode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", maxBufferedEntries: 3, fetch: stubFetch(sent) });

    log.info("1"); log.info("2"); log.info("3"); log.info("4"); log.info("5");
    expect(warn).toHaveBeenCalledTimes(1);
    await log.flush();
    expect(sent).toHaveLength(1);
    expect(sentEntries(sent[0]).map((e: any) => e.message)).toEqual(["3", "4", "5"]);

    // The successful flush above cleared the warn flag; a fresh overflow
    // episode must warn again, not stay silent because of the first one.
    log.info("6"); log.info("7"); log.info("8"); log.info("9");
    expect(warn).toHaveBeenCalledTimes(2);
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
    expect(warn.mock.calls[0][0]).toContain("(3 attempts)");
  });

  it("does not retry a 4xx response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_bad", url: "http://x", fetch: fetchFn });
    log.info("rejected");
    await log.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // A single immediate 4xx drop is one attempt, not "after retries".
    expect(warn.mock.calls[0][0]).toContain("(1 attempts)");
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
    // The entry is quarantined at log() time now (never reaches the
    // buffer), so flush() has nothing to send; still exactly one warn.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops an oversized entry at log time without poisoning the batch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    log.info("ok1");
    log.info("x".repeat(65 * 1024));
    log.info("ok2");
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sentEntries(sent[0]).map((e: any) => e.message)).toEqual(["ok1", "ok2"]);
  });

  it("drops a circular-meta entry at log time; subsequent entries still deliver", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info("before", circular);
    log.info("after");
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sentEntries(sent[0])).toHaveLength(1);
    expect(sentEntries(sent[0])[0].message).toBe("after");
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

describe("Froe request timeout", () => {
  // AbortSignal.timeout schedules its own internal timer outside Node's
  // public timer functions; vi.useFakeTimers (even with every timer name
  // in `toFake`) does not advance it, verified empirically against this
  // Vitest/Node combination. Real timers with a small requestTimeoutMs
  // are the only way to exercise the abort path deterministically.
  afterEach(() => vi.restoreAllMocks());

  it("aborts a hung send after requestTimeoutMs, retries, then drops with one warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn((_url: any, init: any) => {
      // Simulates a black-hole server: the connection is accepted but
      // nothing ever comes back, so only the abort signal settles this.
      return new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const fetchFn = fetchMock as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", requestTimeoutMs: 50, fetch: fetchFn });
    log.info("hangs forever");

    await log.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("(3 attempts)");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }, 10000);
});
