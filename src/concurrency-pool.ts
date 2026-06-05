/**
 * ConcurrencyPool — a deep module that enforces a strict upper bound
 * on parallel task execution using a semaphore counter.
 *
 * Interface (public):
 *   run(fn)    — dispatch a task; if at limit, queues until a slot frees
 *   drain()    — wait for all dispatched tasks to complete
 */

export class ConcurrencyPool {
  private concurrency: number;
  private active = 0;
  private waiting: Array<() => void> = [];
  private running = new Set<Promise<void>>();

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  /** Dispatch a task. If at the concurrency limit, queues until a slot frees. */
  run(fn: () => Promise<void>): void {
    if (this.active < this.concurrency) {
      this.active++;
      this.startTask(fn);
    } else {
      // Queue: wait for a slot, then start
      const queued = new Promise<() => Promise<void>>((resolveQueue) => {
        this.waiting.push(() => resolveQueue(fn));
      }).then(async (queuedFn) => {
        this.active++;
        await queuedFn();
        this.slotFree();
      }).catch(() => {});

      this.running.add(queued);
      queued.finally(() => this.running.delete(queued));
    }
  }

  private startTask(fn: () => Promise<void>): void {
    const task = (async () => { await fn(); })()
      .catch(() => {})
      .finally(() => this.slotFree());
    this.running.add(task);
    task.finally(() => this.running.delete(task));
  }

  private slotFree(): void {
    this.active--;
    const nextResolve = this.waiting.shift();
    if (nextResolve) {
      nextResolve();
    }
  }

  /** Wait for all dispatched tasks to complete. */
  async drain(): Promise<void> {
    await Promise.allSettled(Array.from(this.running));
  }
}