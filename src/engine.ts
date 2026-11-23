import type { ActiveWindow, ChaosConfig } from './config.js';
import type { ContainerInfo, DockerClient } from './docker.js';
import { waitForRecovery, type HealthChecker, type HealthSample } from './health.js';

export type ExperimentAction = 'killed' | 'would-kill' | 'skipped';

export interface ExperimentResult {
  startedAt: Date;
  dryRun: boolean;
  hypothesis: string;
  victim: ContainerInfo | null;
  action: ExperimentAction;
  skipReason: string | null;
  /** Health of every configured endpoint, snapshotted before anything was killed. */
  healthBefore: Record<string, boolean>;
  /** Null when recovery was not measured (dry run or skipped experiment). */
  recovered: boolean | null;
  recoveryMs: number | null;
  samples: HealthSample[];
  verdict: string;
}

export const HYPOTHESIS =
  'Steady state: every opted-in service answers its health check. If one container is killed, ' +
  'the service returns to healthy within the recovery timeout with no manual intervention.';

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True when `date` (local time) falls inside the window. Windows may wrap past midnight. */
export function isWithinActiveWindow(date: Date, window: ActiveWindow | null): boolean {
  if (!window) return true;
  const current = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

export interface EngineDeps {
  docker: DockerClient;
  health: HealthChecker;
  config: ChaosConfig;
  rng?: () => number;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Name of the monkey's own container, so it can never kill itself. */
  selfName?: string | null;
}

export class ChaosEngine {
  private readonly rng: () => number;
  private readonly clock: () => Date;
  private readonly log: (message: string) => void;
  private stopped = false;

  constructor(private readonly deps: EngineDeps) {
    this.rng = deps.rng ?? Math.random;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep
      ? this.deps.sleep(ms)
      : new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * The blast radius rules live here: a container is eligible only if it opted
   * in with the configured label, is currently running, is not on the exclude
   * list, and is not the monkey itself.
   */
  eligibleVictims(containers: ContainerInfo[]): ContainerInfo[] {
    const { labelKey, labelValue, excludeNames } = this.deps.config;
    const excluded = new Set(excludeNames);
    if (this.deps.selfName) excluded.add(this.deps.selfName);
    return containers.filter(
      (c) =>
        c.labels[labelKey] === labelValue && c.state === 'running' && !excluded.has(c.name),
    );
  }

  /** Pick exactly one victim (blast radius: one), or null when nobody is eligible. */
  selectVictim(containers: ContainerInfo[]): ContainerInfo | null {
    const eligible = this.eligibleVictims(containers);
    if (eligible.length === 0) return null;
    const index = Math.min(eligible.length - 1, Math.floor(this.rng() * eligible.length));
    return eligible[index];
  }

  /** Resolve the health URL for a victim: exact name, then chaos.service label, then substring. */
  healthUrlFor(victim: ContainerInfo): string | null {
    const endpoints = this.deps.config.healthEndpoints;
    if (endpoints[victim.name]) return endpoints[victim.name];
    const service = victim.labels['chaos.service'];
    if (service && endpoints[service]) return endpoints[service];
    for (const key of Object.keys(endpoints)) {
      if (victim.name.includes(key)) return endpoints[key];
    }
    return null;
  }

  async snapshotHealth(): Promise<Record<string, boolean>> {
    const endpoints = this.deps.config.healthEndpoints;
    const snapshot: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(endpoints).map(async ([name, url]) => {
        snapshot[name] = await this.deps.health.check(url);
      }),
    );
    return snapshot;
  }

  async runOnce(opts: { live: boolean }): Promise<ExperimentResult> {
    const cfg = this.deps.config;
    const result: ExperimentResult = {
      startedAt: this.clock(),
      dryRun: !opts.live,
      hypothesis: HYPOTHESIS,
      victim: null,
      action: 'skipped',
      skipReason: null,
      healthBefore: {},
      recovered: null,
      recoveryMs: null,
      samples: [],
      verdict: '',
    };

    if (!isWithinActiveWindow(result.startedAt, cfg.activeWindow)) {
      result.skipReason = `outside the active window (${cfg.activeWindow?.start} to ${cfg.activeWindow?.end})`;
      result.verdict = 'Skipped: outside the configured active hours, so no experiment ran.';
      return result;
    }

    const containers = await this.deps.docker.listContainers();
    result.healthBefore = await this.snapshotHealth();

    const victim = this.selectVictim(containers);
    if (!victim) {
      result.skipReason = `no eligible containers (need a running container labeled ${cfg.labelKey}=${cfg.labelValue})`;
      result.verdict = 'Skipped: no container opted in, so there was nothing to test.';
      return result;
    }
    result.victim = victim;

    if (this.rng() >= cfg.killProbability) {
      result.skipReason = `probability roll failed (kill probability is ${cfg.killProbability})`;
      result.verdict = 'Skipped: the probability roll spared everyone this round.';
      return result;
    }

    if (!opts.live) {
      result.action = 'would-kill';
      result.verdict = `Dry run: ${victim.name} would have been killed. No container was touched.`;
      return result;
    }

    this.log(`killing ${victim.name} (${victim.id.slice(0, 12)})`);
    await this.deps.docker.kill(victim.id);
    result.action = 'killed';

    const url = this.healthUrlFor(victim);
    const check = url
      ? () => this.deps.health.check(url)
      : async () => (await this.deps.docker.getState(victim.id)) === 'running';

    const outcome = await waitForRecovery(check, {
      timeoutMs: cfg.recoveryTimeoutSeconds * 1000,
      pollMs: cfg.pollIntervalSeconds * 1000,
      now: () => this.clock().getTime(),
      sleep: (ms) => this.sleep(ms),
    });
    result.samples = outcome.samples;
    result.recovered = outcome.recovered;
    result.recoveryMs = outcome.durationMs;
    result.verdict = outcome.recovered
      ? `Hypothesis held: ${victim.name} recovered in ${((outcome.durationMs ?? 0) / 1000).toFixed(1)}s with no manual intervention.`
      : `Hypothesis violated: ${victim.name} did not recover within ${cfg.recoveryTimeoutSeconds}s. This service needs a restart policy, a replica, or a human.`;
    return result;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Daemon mode: run an experiment, wait intervalSeconds, repeat until stopped. */
  async runDaemon(opts: {
    live: boolean;
    maxTicks?: number;
    onExperiment?: (result: ExperimentResult) => Promise<void> | void;
  }): Promise<void> {
    let tick = 0;
    while (!this.stopped) {
      const result = await this.runOnce({ live: opts.live });
      if (opts.onExperiment) await opts.onExperiment(result);
      tick += 1;
      if (opts.maxTicks !== undefined && tick >= opts.maxTicks) break;
      await this.sleep(this.deps.config.intervalSeconds * 1000);
    }
  }
}
