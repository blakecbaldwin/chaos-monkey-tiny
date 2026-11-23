export interface HealthSample {
  /** Milliseconds since recovery polling started. */
  atMs: number;
  ok: boolean;
}

export interface RecoveryOutcome {
  recovered: boolean;
  /** Time from the first poll to the first healthy response, or null if it never recovered. */
  durationMs: number | null;
  samples: HealthSample[];
}

export interface HealthChecker {
  check(url: string): Promise<boolean>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpHealthChecker implements HealthChecker {
  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly timeoutMs = 2000,
  ) {}

  async check(url: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `check` until it returns true or the timeout runs out, recording every
 * sample so the report can show the full health timeline.
 */
export async function waitForRecovery(
  check: () => Promise<boolean>,
  opts: WaitOptions,
): Promise<RecoveryOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  const samples: HealthSample[] = [];

  for (;;) {
    const ok = await check();
    const elapsed = now() - start;
    samples.push({ atMs: elapsed, ok });
    if (ok) return { recovered: true, durationMs: elapsed, samples };
    if (elapsed >= opts.timeoutMs) return { recovered: false, durationMs: null, samples };
    await sleep(Math.min(opts.pollMs, opts.timeoutMs - elapsed));
  }
}
