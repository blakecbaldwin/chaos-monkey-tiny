import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ChaosConfig } from '../src/config.js';
import { ChaosEngine, isWithinActiveWindow } from '../src/engine.js';
import { FakeDockerClient, FakeHealthChecker, makeContainer, makeFakeClock } from './fakes.js';

function config(partial: Partial<ChaosConfig> = {}): ChaosConfig {
  return {
    ...DEFAULT_CONFIG,
    killProbability: 1,
    healthEndpoints: {},
    excludeNames: [],
    ...partial,
  };
}

function engineWith(
  docker: FakeDockerClient,
  health: FakeHealthChecker,
  cfg: ChaosConfig,
  extra: { rng?: () => number; selfName?: string | null } = {},
) {
  const fakeClock = makeFakeClock();
  const engine = new ChaosEngine({
    docker,
    health,
    config: cfg,
    rng: extra.rng ?? (() => 0),
    clock: fakeClock.clock,
    sleep: fakeClock.sleep,
    selfName: extra.selfName ?? null,
  });
  return { engine, fakeClock };
}

describe('victim selection', () => {
  it('only picks containers carrying the opt-in label', () => {
    const optedIn = makeContainer({ name: 'opted-in' });
    const notLabeled = makeContainer({ name: 'plain', labels: {} });
    const labeledOff = makeContainer({ name: 'off', labels: { 'chaos.enabled': 'false' } });
    const docker = new FakeDockerClient([notLabeled, labeledOff, optedIn]);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    expect(engine.eligibleVictims([notLabeled, labeledOff, optedIn])).toEqual([optedIn]);
    expect(engine.selectVictim([notLabeled, labeledOff, optedIn])?.name).toBe('opted-in');
  });

  it('ignores containers that are not running', () => {
    const exited = makeContainer({ name: 'dead', state: 'exited' });
    const docker = new FakeDockerClient([exited]);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    expect(engine.selectVictim([exited])).toBeNull();
  });

  it('never targets excluded names or the monkey itself', () => {
    const mine = makeContainer({ name: 'chaos-monkey' });
    const excluded = makeContainer({ name: 'database' });
    const fair = makeContainer({ name: 'api' });
    const docker = new FakeDockerClient([mine, excluded, fair]);
    const { engine } = engineWith(
      docker,
      new FakeHealthChecker(() => true),
      config({ excludeNames: ['database'] }),
      { selfName: 'chaos-monkey' },
    );
    expect(engine.eligibleVictims([mine, excluded, fair])).toEqual([fair]);
  });

  it('uses the rng to choose among eligible victims', () => {
    const a = makeContainer({ name: 'a' });
    const b = makeContainer({ name: 'b' });
    const docker = new FakeDockerClient([a, b]);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config(), {
      rng: () => 0.99,
    });
    expect(engine.selectVictim([a, b])?.name).toBe('b');
  });
});

describe('runOnce safety', () => {
  it('dry run never calls kill, even with eligible victims', async () => {
    const victim = makeContainer({ name: 'api' });
    const docker = new FakeDockerClient([victim]);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    const result = await engine.runOnce({ live: false });
    expect(result.action).toBe('would-kill');
    expect(result.victim?.name).toBe('api');
    expect(docker.kills).toEqual([]);
  });

  it('blast radius is one: a live run kills exactly one container', async () => {
    const containers = [makeContainer({ name: 'a' }), makeContainer({ name: 'b' }), makeContainer({ name: 'c' })];
    const docker = new FakeDockerClient(containers);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    const result = await engine.runOnce({ live: true });
    expect(result.action).toBe('killed');
    expect(docker.kills).toHaveLength(1);
  });

  it('probability of zero always skips the kill', async () => {
    const docker = new FakeDockerClient([makeContainer({ name: 'api' })]);
    const { engine } = engineWith(
      docker,
      new FakeHealthChecker(() => true),
      config({ killProbability: 0 }),
    );
    const result = await engine.runOnce({ live: true });
    expect(result.action).toBe('skipped');
    expect(result.skipReason).toContain('probability');
    expect(docker.kills).toEqual([]);
  });

  it('skips when there are no eligible containers', async () => {
    const docker = new FakeDockerClient([makeContainer({ name: 'plain', labels: {} })]);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    const result = await engine.runOnce({ live: true });
    expect(result.action).toBe('skipped');
    expect(result.skipReason).toContain('no eligible containers');
    expect(docker.kills).toEqual([]);
  });
});

describe('active window', () => {
  it('matches times inside a same-day window', () => {
    const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m);
    const window = { start: '09:00', end: '17:00' };
    expect(isWithinActiveWindow(at(8, 59), window)).toBe(false);
    expect(isWithinActiveWindow(at(9), window)).toBe(true);
    expect(isWithinActiveWindow(at(16, 59), window)).toBe(true);
    expect(isWithinActiveWindow(at(17), window)).toBe(false);
  });

  it('handles windows that wrap past midnight', () => {
    const at = (h: number) => new Date(2026, 0, 5, h, 0);
    const window = { start: '22:00', end: '02:00' };
    expect(isWithinActiveWindow(at(23), window)).toBe(true);
    expect(isWithinActiveWindow(at(1), window)).toBe(true);
    expect(isWithinActiveWindow(at(12), window)).toBe(false);
  });

  it('null window means always active, and the engine skips outside the window', async () => {
    expect(isWithinActiveWindow(new Date(), null)).toBe(true);
    const docker = new FakeDockerClient([makeContainer({ name: 'api' })]);
    const fakeClock = makeFakeClock();
    const engine = new ChaosEngine({
      docker,
      health: new FakeHealthChecker(() => true),
      config: config({ activeWindow: { start: '03:00', end: '04:00' } }),
      rng: () => 0,
      // Fake clock starts at a fixed instant; force the hour by using a real Date far from 03:00.
      clock: () => new Date(2026, 0, 5, 12, 0),
      sleep: fakeClock.sleep,
    });
    const result = await engine.runOnce({ live: true });
    expect(result.action).toBe('skipped');
    expect(result.skipReason).toContain('active window');
    expect(docker.kills).toEqual([]);
  });
});

describe('recovery measurement', () => {
  it('records recovery when the health check comes back', async () => {
    const victim = makeContainer({
      name: 'proj-resilient-api-1',
      labels: { 'chaos.enabled': 'true', 'chaos.service': 'resilient-api' },
    });
    const docker = new FakeDockerClient([victim]);
    let pollsAfterKill = 0;
    const health = new FakeHealthChecker(() => {
      // Snapshot calls happen before the kill; once killed, fail twice then recover.
      if (docker.kills.length === 0) return true;
      pollsAfterKill += 1;
      return pollsAfterKill >= 3;
    });
    const { engine } = engineWith(
      docker,
      health,
      config({
        healthEndpoints: { 'resilient-api': 'http://localhost:8081/health' },
        recoveryTimeoutSeconds: 30,
        pollIntervalSeconds: 1,
      }),
    );
    const result = await engine.runOnce({ live: true });
    expect(result.action).toBe('killed');
    expect(result.recovered).toBe(true);
    expect(result.recoveryMs).toBe(2000);
    expect(result.samples.map((s) => s.ok)).toEqual([false, false, true]);
    expect(result.verdict).toContain('Hypothesis held');
    expect(result.healthBefore).toEqual({ 'resilient-api': true });
  });

  it('reports a non-recovery when the timeout runs out', async () => {
    const victim = makeContainer({
      name: 'proj-fragile-api-1',
      labels: { 'chaos.enabled': 'true', 'chaos.service': 'fragile-api' },
    });
    const docker = new FakeDockerClient([victim]);
    const health = new FakeHealthChecker(() => docker.kills.length === 0);
    const { engine } = engineWith(
      docker,
      health,
      config({
        healthEndpoints: { 'fragile-api': 'http://localhost:8082/health' },
        recoveryTimeoutSeconds: 5,
        pollIntervalSeconds: 1,
      }),
    );
    const result = await engine.runOnce({ live: true });
    expect(result.recovered).toBe(false);
    expect(result.recoveryMs).toBeNull();
    expect(result.samples.length).toBeGreaterThan(1);
    expect(result.samples.every((s) => !s.ok)).toBe(true);
    expect(result.verdict).toContain('Hypothesis violated');
  });

  it('falls back to container state when no health endpoint matches', async () => {
    const victim = makeContainer({ name: 'worker' });
    const docker = new FakeDockerClient([victim]);
    // Simulate a restart policy: the container comes back on the second state poll.
    let statePolls = 0;
    const originalGetState = docker.getState.bind(docker);
    docker.getState = async (id: string) => {
      statePolls += 1;
      if (docker.kills.includes(id) && statePolls < 2) return 'exited';
      if (docker.kills.includes(id)) return 'running';
      return originalGetState(id);
    };
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    const result = await engine.runOnce({ live: true });
    expect(result.recovered).toBe(true);
  });
});

describe('daemon mode', () => {
  it('runs the requested number of ticks and respects the blast radius each tick', async () => {
    const containers = [makeContainer({ name: 'a' }), makeContainer({ name: 'b' })];
    const docker = new FakeDockerClient(containers);
    const { engine } = engineWith(docker, new FakeHealthChecker(() => true), config());
    const seen: string[] = [];
    await engine.runDaemon({
      live: false,
      maxTicks: 3,
      onExperiment: (r) => {
        seen.push(r.action);
      },
    });
    expect(seen).toEqual(['would-kill', 'would-kill', 'would-kill']);
    expect(docker.kills).toEqual([]);
  });
});
