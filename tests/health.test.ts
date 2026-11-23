import { describe, expect, it } from 'vitest';
import { HttpHealthChecker, waitForRecovery } from '../src/health.js';

function fakeTimer() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe('waitForRecovery', () => {
  it('returns as soon as the check passes and records the timeline', async () => {
    const timer = fakeTimer();
    let calls = 0;
    const outcome = await waitForRecovery(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      { timeoutMs: 10_000, pollMs: 500, now: timer.now, sleep: timer.sleep },
    );
    expect(outcome.recovered).toBe(true);
    expect(outcome.durationMs).toBe(1000);
    expect(outcome.samples).toEqual([
      { atMs: 0, ok: false },
      { atMs: 500, ok: false },
      { atMs: 1000, ok: true },
    ]);
  });

  it('gives up at the timeout and reports no recovery', async () => {
    const timer = fakeTimer();
    const outcome = await waitForRecovery(async () => false, {
      timeoutMs: 2000,
      pollMs: 500,
      now: timer.now,
      sleep: timer.sleep,
    });
    expect(outcome.recovered).toBe(false);
    expect(outcome.durationMs).toBeNull();
    expect(outcome.samples[outcome.samples.length - 1].atMs).toBe(2000);
  });

  it('an immediately healthy service recovers with duration zero', async () => {
    const timer = fakeTimer();
    const outcome = await waitForRecovery(async () => true, {
      timeoutMs: 2000,
      pollMs: 500,
      now: timer.now,
      sleep: timer.sleep,
    });
    expect(outcome).toEqual({ recovered: true, durationMs: 0, samples: [{ atMs: 0, ok: true }] });
  });
});

describe('HttpHealthChecker', () => {
  it('treats a 200 as healthy and a 500 as unhealthy', async () => {
    const okChecker = new HttpHealthChecker(async () => new Response('ok', { status: 200 }));
    const badChecker = new HttpHealthChecker(async () => new Response('nope', { status: 500 }));
    await expect(okChecker.check('http://x/health')).resolves.toBe(true);
    await expect(badChecker.check('http://x/health')).resolves.toBe(false);
  });

  it('treats a network error as unhealthy instead of throwing', async () => {
    const checker = new HttpHealthChecker(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(checker.check('http://x/health')).resolves.toBe(false);
  });
});
