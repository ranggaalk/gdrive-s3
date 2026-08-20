import { describe, expect, test } from "bun:test";
import { KeyedSemaphore, Semaphore, withSemaphore } from "../../apps/server/src/util/semaphore.ts";

describe("Semaphore", () => {
  test("caps concurrency and queues waiters", async () => {
    const sem = new Semaphore(2);
    const started: number[] = [];
    let concurrent = 0;
    let peak = 0;
    const work = async (id: number) =>
      withSemaphore(sem, undefined, async () => {
        started.push(id);
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
      });
    await Promise.all([1, 2, 3, 4, 5].map((id) => work(id)));
    expect(peak).toBe(2);
    expect(new Set(started).size).toBe(5);
  });

  test("aborts waiting acquirer", async () => {
    const sem = new Semaphore(1);
    const blocker = await sem.acquire();
    const controller = new AbortController();
    const promise = sem.acquire(controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
    blocker.release();
    const slot = await sem.acquire();
    slot.release();
  });

  test("release-on-error still frees the slot", async () => {
    const sem = new Semaphore(1);
    await expect(
      withSemaphore(sem, undefined, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    const next = await sem.acquire();
    next.release();
  });
});

describe("KeyedSemaphore", () => {
  test("caps per key, not globally", async () => {
    const sem = new KeyedSemaphore(1);
    let aRunning = 0;
    let bRunning = 0;
    const task = (key: string, counter: { n: number }) =>
      withSemaphore(sem, key, async () => {
        counter.n++;
        await new Promise((r) => setTimeout(r, 5));
        counter.n--;
      });
    const aCounter = { n: 0 };
    const bCounter = { n: 0 };
    const pending = [
      task("a", aCounter),
      task("a", aCounter),
      task("b", bCounter),
    ];
    await new Promise((r) => setTimeout(r, 1));
    aRunning = aCounter.n;
    bRunning = bCounter.n;
    expect(aRunning).toBe(1);
    expect(bRunning).toBe(1);
    await Promise.all(pending);
  });
});
