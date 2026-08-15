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

function keyOf(s: Sent): string {
  return (s.init.headers as any)["idempotency-key"];
}

// A fetch stub with a switchable outage: while `down` is true every call
// fails like a dead server, afterwards calls succeed. Used by the retry
// queue tests, which all follow the shape "fail, recover, verify".
function flakyFetch(sent: Sent[]) {
  const state = { down: true };
  const fetchFn = vi.fn(async (url: any, init: any) => {
    sent.push({ url: String(url), init });
    if (state.down) throw new Error("ECONNREFUSED");
    return new Response("{}", { status: 202 });
  }) as unknown as typeof globalThis.fetch;
  return { state, fetchFn };
}

// A fetch whose settlement the test controls: each call records itself and
// returns a promise the test resolves or rejects later, so tests can
// overlap flush() calls and overflow evictions with a send that is still
// in flight (the other stubs settle in an immediate microtask, which can
// never produce that overlap).
function deferredFetch(sent: Sent[]) {
  const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fetchFn = vi.fn((url: any, init: any) => {
    sent.push({ url: String(url), init });
    return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
  }) as unknown as typeof globalThis.fetch;
  return { pending, fetchFn };
}

// White-box view of how many entries the SDK holds in memory, buffer plus
// queued batches; the memory-bound test asserts the documented cap on it.
function heldEntries(log: Froe): number {
  const anyLog = log as any;
  const queued = anyLog.queue.reduce((n: number, b: any) => n + b.count, 0);
  return anyLog.buffer.length + queued;
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

describe("Froe memory bound", () => {
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

  it("bounds buffer plus queued entries under one cap, evicting the oldest queued batch first", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    // batchSize above everything logged here so batches form only on the
    // explicit flushes, keeping the queue contents deterministic.
    const log = new Froe({
      key: "fw_k", url: "http://x", batchSize: 100,
      maxBufferedEntries: 4, fetch: fetchFn,
    });

    log.info("m1"); log.info("m2");
    await log.flush(); // batch [m1, m2] queued; the send fails
    log.info("m3"); log.info("m4");
    await log.flush(); // batch [m3, m4] queued behind it; held total is 4
    expect(heldEntries(log)).toBe(4);
    expect(warn).not.toHaveBeenCalled();

    // The fifth entry pushes the total over the cap; the oldest queued
    // batch is evicted whole, and exactly one warn fires.
    log.info("m5");
    expect(heldEntries(log)).toBeLessThanOrEqual(4);
    expect(warn).toHaveBeenCalledTimes(1);

    // What survives and gets delivered proves eviction order: the head
    // batch [m1, m2] is gone, the newer batch and entry are intact.
    const failedAttempts = sent.length;
    state.down = false;
    await log.flush();
    const delivered = sent
      .slice(failedAttempts)
      .flatMap((s) => sentEntries(s).map((e: any) => e.message));
    expect(delivered).toEqual(["m3", "m4", "m5"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Froe retry queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a batch that failed with a network error queued and delivers it on a later flush under the same idempotency key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("survives");
    await log.flush(); // one pass, one failed attempt, batch stays queued
    expect(sent).toHaveLength(1);
    state.down = false;
    await log.flush();
    expect(sent).toHaveLength(2);
    // The same frozen batch was retried: identical key, identical body.
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
    expect(String(sent[1].init.body)).toBe(String(sent[0].init.body));
    expect(warn).not.toHaveBeenCalled(); // nothing was dropped
  });

  it("keeps a batch queued on a 500 and delivers it once the server recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    let status = 500;
    const fetchFn = vi.fn(async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      return new Response("{}", { status });
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("kept");
    await log.flush();
    expect(sent).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    status = 202;
    await log.flush();
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
  });

  it("drops exactly the batch a 400 rejected, with one warn naming count and status, and the next batch still sends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    let status = 400;
    const fetchFn = vi.fn(async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      return new Response("{}", { status });
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("rejected");
    await log.flush();
    expect(sent).toHaveLength(1); // no retry: the request itself is wrong
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("1 entries");
    expect(warn.mock.calls[0][0]).toContain("status 400");
    status = 202;
    log.info("next");
    await log.flush();
    expect(sent).toHaveLength(2);
    expect(sentEntries(sent[1])[0].message).toBe("next");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a 429 batch and honors Retry-After for the next attempt's delay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    let calls = 0;
    const fetchFn = vi.fn(async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      calls++;
      if (calls === 1) {
        return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
      }
      return new Response("{}", { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", flushIntervalMs: 500, fetch: fetchFn });
    log.info("limited");
    await log.flush(); // 429; next attempt gated to roughly 2 seconds out
    expect(sent).toHaveLength(1);
    // Ticks fire at 500, 1000, and 1500 ms; all sit before the 2 second
    // Retry-After gate, so none may attempt (the default backoff would
    // have allowed a retry after 250 ms, proving the header won).
    await vi.advanceTimersByTimeAsync(1900);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600); // the tick past 2000 ms retries
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
    expect(warn).not.toHaveBeenCalled(); // 429 never drops the batch
  });

  it("does not attempt on a full buffer while the retry gate is closed", async () => {
    const sent: Sent[] = [];
    const fetchFn = vi.fn(async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({
      key: "fw_k", url: "http://x", batchSize: 2, flushIntervalMs: 500, fetch: fetchFn,
    });

    log.info("1"); log.info("2");
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1); // nothing is gated yet, so the full buffer ships

    // A hot logger keeps filling the buffer through the 2 second gate. A
    // full buffer is not a shutdown: each one queues its batch and waits,
    // or the backoff and the server's Retry-After are defeated exactly
    // when the server is under most pressure.
    for (let i = 0; i < 20; i++) log.info(`hot ${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1500); // the tick past the gate retries
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0])); // still the head batch, in order
  });

  it("never attempts the second queued batch before the failing head succeeds, then delivers both in order", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("first");
    await log.flush(); // head batch [first] queued, attempt fails
    log.info("second");
    await log.flush(); // batch [second] queued behind; only the head retries
    // Every attempt so far carried the head batch, never the second.
    for (const s of sent) {
      expect(sentEntries(s).map((e: any) => e.message)).toEqual(["first"]);
    }
    state.down = false;
    await log.flush();
    const lastTwo = sent.slice(-2).map((s) => sentEntries(s)[0].message);
    expect(lastTwo).toEqual(["first", "second"]);
  });

  it("gates interval ticks by the backoff, while an explicit flush() attempts immediately", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", flushIntervalMs: 500, fetch: fetchFn });
    log.info("gated");
    await log.flush(); // failure 1: next attempt allowed 250 ms out
    await log.flush(); // failure 2 (explicit, so it ignored the 250 ms gate)
    expect(sent).toHaveLength(2);
    // After two failures the backoff is 1000 ms, so the tick at 500 ms
    // sits before nextAttemptAt and must send nothing.
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(2);
    // An explicit flush ignores the gate and attempts right now.
    await log.flush();
    expect(sent).toHaveLength(3);
  });

  it("caps the retry delay at 30 seconds, for both the backoff and Retry-After", async () => {
    let rateLimited = false;
    const fetchFn = vi.fn(async () => {
      if (rateLimited) {
        return new Response("{}", { status: 429, headers: { "retry-after": "99999" } });
      }
      throw new Error("down");
    }) as unknown as typeof globalThis.fetch;
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("x");
    // Five consecutive failures push the raw backoff to 64 seconds; the
    // cap must hold the gate at 30.
    for (let i = 0; i < 5; i++) await log.flush();
    expect((log as any).nextAttemptAt - Date.now()).toBe(30_000);
    // A huge Retry-After must not gate the queue past the same ceiling.
    rateLimited = true;
    await log.flush();
    expect((log as any).nextAttemptAt - Date.now()).toBe(30_000);
  });

  it("flush() makes one pass while the server is down, resolves promptly, and leaves the queue intact", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("waiting");
    // Under fake timers, a flush that slept through retries would never
    // resolve here; resolving with exactly one attempt proves the single
    // ordered pass.
    await log.flush();
    expect(sent).toHaveLength(1);
    state.down = false;
    await log.flush();
    expect(sentEntries(sent[1])[0].message).toBe("waiting");
  });

  it("keeps the interval running while the queue is non-empty and clears it once everything is delivered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", flushIntervalMs: 500, fetch: fetchFn });
    log.info("pending");
    await log.flush(); // buffer now empty, but the queue holds the batch
    expect((log as any).timer).toBeDefined();
    state.down = false;
    // The tick at 500 ms is past the 250 ms backoff, so it delivers, and
    // with buffer and queue both empty the timer clears itself.
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(2);
    expect((log as any).timer).toBeUndefined();
  });

  it("keeps working after a failed send: nothing is lost and order is preserved", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("first");
    await log.flush(); // fails; under the old policy this batch died here
    state.down = false;
    log.info("second");
    await log.flush();
    const delivered = sent.slice(1).map((s) => sentEntries(s)[0].message);
    expect(delivered).toEqual(["first", "second"]);
  });

  it("never throws, even with circular meta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch([]) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info("odd", circular)).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    // The entry is quarantined at log() time (never reaches the buffer),
    // so flush() has nothing to send; still exactly one warn.
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
    // The batch stays queued forever (fetch never works), but flush must
    // still resolve after its single pass.
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe("Froe in-flight overlap", () => {
  // These tests interleave with a send that has not settled yet, so they
  // use real timers: draining on a zero setTimeout (a macrotask) lets
  // every pending microtask in the SDK's await chains run first.
  afterEach(() => vi.restoreAllMocks());

  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const ok = () => new Response("{}", { status: 202 });

  it("a flush() that joins an in-flight pass still attempts the batch it formed before resolving", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { pending, fetchFn } = deferredFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("first");
    const first = log.flush(); // batch [first] is now in flight
    expect(sent).toHaveLength(1);
    log.info("second");
    const second = log.flush(); // forms [second] and joins the in-flight pass
    expect(sent).toHaveLength(1);
    // The in-flight attempt fails, so the joined pass exits without ever
    // touching [second]; the second flush must run a pass of its own
    // instead of resolving with its batch stranded in the queue (a
    // shutdown hook awaiting it would otherwise lose the batch with the
    // server up).
    pending[0].reject(new Error("down"));
    await first;
    await drain();
    expect(sent).toHaveLength(2); // the fresh pass retried the head
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
    pending[1].resolve(ok());
    await drain();
    expect(sent).toHaveLength(3); // and moved on to [second], in order
    expect(sentEntries(sent[2])[0].message).toBe("second");
    pending[2].resolve(ok());
    await second;
  });

  it("an overflow eviction of the in-flight head batch does not corrupt the queue", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { pending, fetchFn } = deferredFetch(sent);
    const log = new Froe({
      key: "fw_k", url: "http://x", batchSize: 100,
      maxBufferedEntries: 4, fetch: fetchFn,
    });
    log.info("a1"); log.info("a2");
    const first = log.flush(); // batch A [a1, a2] is now in flight
    log.info("b1"); log.info("b2");
    const second = log.flush(); // batch B queued behind A; held total is 4
    expect(sent).toHaveLength(1);
    // The fifth entry evicts A, the oldest batch, while its request is
    // still in flight.
    log.info("c1");
    expect(warn).toHaveBeenCalledTimes(1);
    // A's request then lands. A blind shift would remove B in A's place
    // and lose it; removal by identity leaves B intact as the next head.
    pending[0].resolve(ok());
    await drain();
    expect(sent).toHaveLength(2);
    expect(sentEntries(sent[1]).map((e: any) => e.message)).toEqual(["b1", "b2"]);
    pending[1].resolve(ok());
    await Promise.all([first, second]);
    // The buffered entry still delivers on a later flush, and only the
    // eviction warned, once.
    const third = log.flush();
    expect(sent).toHaveLength(3);
    pending[2].resolve(ok());
    await third;
    expect(sentEntries(sent[2])[0].message).toBe("c1");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Froe idempotency", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("sends a well-formed UUID Idempotency-Key on a push", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    log.info("1");
    await log.flush();
    expect(sent).toHaveLength(1);
    expect(keyOf(sent[0])).toMatch(UUID);
  });

  it("reuses the same Idempotency-Key on every retry of one batch, across flush passes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const { state, fetchFn } = flakyFetch(sent);
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: fetchFn });
    log.info("flaky");
    await log.flush(); // attempt 1 fails; the batch keeps its key
    await log.flush(); // attempt 2 fails too
    state.down = false;
    await log.flush(); // attempt 3 lands
    expect(sent).toHaveLength(3);
    expect(keyOf(sent[0])).toMatch(UUID);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
    expect(keyOf(sent[2])).toBe(keyOf(sent[0]));
  });

  it("uses a different Idempotency-Key for each batch", async () => {
    const sent: Sent[] = [];
    const log = new Froe({ key: "fw_k", url: "http://x", fetch: stubFetch(sent) });
    log.info("first batch");
    await log.flush();
    log.info("second batch");
    await log.flush();
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[0])).toMatch(UUID);
    expect(keyOf(sent[1])).toMatch(UUID);
    expect(keyOf(sent[1])).not.toBe(keyOf(sent[0]));
  });
});

describe("Froe request timeout", () => {
  // AbortSignal.timeout schedules its own internal timer outside Node's
  // public timer functions; vi.useFakeTimers (even with every timer name
  // in `toFake`) does not advance it, verified empirically against this
  // Vitest/Node combination. Real timers with a small requestTimeoutMs
  // are the only way to exercise the abort path deterministically.
  afterEach(() => vi.restoreAllMocks());

  it("aborts a hung send after requestTimeoutMs and keeps the batch queued for the next pass", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let hang = true;
    const sent: Sent[] = [];
    const fetchMock = vi.fn((url: any, init: any) => {
      sent.push({ url: String(url), init });
      if (!hang) return Promise.resolve(new Response("{}", { status: 202 }));
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
    log.info("hangs then lands");

    await log.flush(); // the abort settles the single attempt of this pass

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled(); // a timeout is a retry, not a drop
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);

    hang = false;
    await log.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEntries(sent[1])[0].message).toBe("hangs then lands");
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
  }, 10000);
});
