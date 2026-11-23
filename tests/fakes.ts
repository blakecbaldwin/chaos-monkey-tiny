import type { ContainerInfo, DockerClient } from '../src/docker.js';
import type { HealthChecker } from '../src/health.js';

let counter = 0;

export function makeContainer(partial: Partial<ContainerInfo> = {}): ContainerInfo {
  counter += 1;
  return {
    id: `container-${counter}`,
    name: `svc-${counter}`,
    image: 'demo:latest',
    state: 'running',
    labels: { 'chaos.enabled': 'true' },
    ...partial,
  };
}

/** In-memory DockerClient that records every kill instead of performing one. */
export class FakeDockerClient implements DockerClient {
  readonly kills: string[] = [];
  private readonly states = new Map<string, string>();

  constructor(private readonly containers: ContainerInfo[]) {}

  async listContainers(): Promise<ContainerInfo[]> {
    return this.containers;
  }

  async kill(containerId: string): Promise<void> {
    this.kills.push(containerId);
    this.states.set(containerId, 'exited');
  }

  async getState(containerId: string): Promise<string | null> {
    if (this.states.has(containerId)) return this.states.get(containerId) ?? null;
    return this.containers.find((c) => c.id === containerId)?.state ?? null;
  }
}

/** HealthChecker driven by a plain function so tests can script the responses. */
export class FakeHealthChecker implements HealthChecker {
  readonly calls: string[] = [];

  constructor(private readonly handler: (url: string) => boolean) {}

  async check(url: string): Promise<boolean> {
    this.calls.push(url);
    return this.handler(url);
  }
}

/** A clock plus sleep pair where sleeping advances the clock. Makes timeouts deterministic and instant. */
export function makeFakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    clock: () => new Date(now),
    nowMs: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}
