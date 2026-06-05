import { describe, expect, it } from 'vitest';
import { ConcurrencyPool } from './concurrency-pool';

describe('ConcurrencyPool', () => {
  // Track max concurrent tasks observed during execution
  function trackConcurrency(concurrency: number, taskCount: number, delayMs: number = 10): Promise<{ maxConcurrent: number; completed: number }> {
    let current = 0;
    let maxConcurrent = 0;
    let completed = 0;
    const pool = new ConcurrencyPool(concurrency);

    return new Promise((resolve) => {
      for (let i = 0; i < taskCount; i++) {
        pool.run(async () => {
          current++;
          if (current > maxConcurrent) maxConcurrent = current;
          await new Promise((r) => setTimeout(r, delayMs));
          completed++;
          current--;
        });
      }

      // After dispatching all, drain and report
      pool.drain().then(() => {
        resolve({ maxConcurrent, completed });
      });
    });
  }

  it('runs tasks with concurrency limit of 1 (sequential)', async () => {
    const result = await trackConcurrency(1, 5, 5);
    expect(result.maxConcurrent).toBe(1);
    expect(result.completed).toBe(5);
  });

  it('never exceeds concurrency limit under burst dispatch', async () => {
    // Dispatch 10 tasks synchronously with limit of 3
    const result = await trackConcurrency(3, 10, 15);
    expect(result.maxConcurrent).toBeLessThanOrEqual(3);
    expect(result.completed).toBe(10);
  });

  it('completes all tasks regardless of concurrency limit', async () => {
    const result = await trackConcurrency(2, 8, 5);
    expect(result.completed).toBe(8);
  });

  it('drain waits for all dispatched tasks', async () => {
    const pool = new ConcurrencyPool(2);
    let completed = 0;

    for (let i = 0; i < 4; i++) {
      pool.run(async () => {
        await new Promise((r) => setTimeout(r, 20));
        completed++;
      });
    }

    await pool.drain();
    expect(completed).toBe(4);
  });

  it('errors in one task do not block other tasks', async () => {
    const pool = new ConcurrencyPool(2);
    let successes = 0;
    let failures = 0;

    // First task throws
    pool.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('task failed');
    });

    // Remaining tasks succeed
    for (let i = 0; i < 3; i++) {
      pool.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        successes++;
      });
    }

    await pool.drain();
    expect(successes).toBe(3);
  });

  it('enforces strict concurrency under high task count', async () => {
    // Stress test: 20 tasks with limit of 3
    const result = await trackConcurrency(3, 20, 10);
    expect(result.maxConcurrent).toBeLessThanOrEqual(3);
    expect(result.completed).toBe(20);
  });
});