import { execFile } from 'node:child_process';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** Lowercase Docker state, e.g. "running" or "exited". */
  state: string;
  labels: Record<string, string>;
}

/**
 * The only surface the chaos engine needs from Docker. Production uses
 * CliDockerClient (the real `docker` CLI); tests substitute a fake.
 */
export interface DockerClient {
  listContainers(): Promise<ContainerInfo[]>;
  kill(containerId: string): Promise<void>;
  /** Current state of one container, or null if it cannot be inspected. */
  getState(containerId: string): Promise<string | null>;
}

/** Parse the "k=v,k2=v2" label string that `docker ps --format {{json .}}` emits. */
export function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!raw) return labels;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return labels;
}

/** Parse the newline-delimited JSON printed by `docker ps --format {{json .}}`. */
export function parsePsOutput(stdout: string): ContainerInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const obj = JSON.parse(line) as Record<string, string>;
      return {
        id: obj.ID ?? '',
        name: (obj.Names ?? '').replace(/^\//, ''),
        image: obj.Image ?? '',
        state: (obj.State ?? '').toLowerCase(),
        labels: parseLabels(obj.Labels ?? ''),
      };
    });
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`"${file} ${args.join(' ')}" failed: ${err.message}`));
      else resolve(stdout);
    });
  });

export class CliDockerClient implements DockerClient {
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  async listContainers(): Promise<ContainerInfo[]> {
    const out = await this.run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    return parsePsOutput(out);
  }

  async kill(containerId: string): Promise<void> {
    await this.run('docker', ['kill', containerId]);
  }

  async getState(containerId: string): Promise<string | null> {
    try {
      const out = await this.run('docker', ['inspect', '--format', '{{.State.Status}}', containerId]);
      const state = out.trim().toLowerCase();
      return state.length > 0 ? state : null;
    } catch {
      return null;
    }
  }
}
