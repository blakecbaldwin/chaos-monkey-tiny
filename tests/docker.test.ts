import { describe, expect, it } from 'vitest';
import { CliDockerClient, parseLabels, parsePsOutput } from '../src/docker.js';

describe('parseLabels', () => {
  it('parses the comma-separated key=value format docker ps emits', () => {
    expect(parseLabels('chaos.enabled=true,chaos.service=resilient-api')).toEqual({
      'chaos.enabled': 'true',
      'chaos.service': 'resilient-api',
    });
  });

  it('keeps equals signs inside values and tolerates empty input', () => {
    expect(parseLabels('')).toEqual({});
    expect(parseLabels('note=a=b')).toEqual({ note: 'a=b' });
  });
});

describe('parsePsOutput', () => {
  it('parses newline-delimited docker ps JSON', () => {
    const stdout = [
      JSON.stringify({
        ID: 'abc123',
        Names: 'proj-resilient-api-1',
        Image: 'demo:latest',
        State: 'running',
        Labels: 'chaos.enabled=true',
      }),
      JSON.stringify({
        ID: 'def456',
        Names: '/proj-fragile-api-1',
        Image: 'demo:latest',
        State: 'Exited',
        Labels: '',
      }),
      '',
    ].join('\n');
    const containers = parsePsOutput(stdout);
    expect(containers).toHaveLength(2);
    expect(containers[0]).toEqual({
      id: 'abc123',
      name: 'proj-resilient-api-1',
      image: 'demo:latest',
      state: 'running',
      labels: { 'chaos.enabled': 'true' },
    });
    expect(containers[1].name).toBe('proj-fragile-api-1');
    expect(containers[1].state).toBe('exited');
  });
});

describe('CliDockerClient', () => {
  it('lists containers through the docker CLI', async () => {
    const calls: string[][] = [];
    const client = new CliDockerClient(async (_file, args) => {
      calls.push(args);
      return JSON.stringify({ ID: 'x1', Names: 'api', Image: 'img', State: 'running', Labels: '' });
    });
    const containers = await client.listContainers();
    expect(calls[0]).toContain('ps');
    expect(containers[0].name).toBe('api');
  });

  it('kills through the docker CLI with the container id', async () => {
    const calls: string[][] = [];
    const client = new CliDockerClient(async (_file, args) => {
      calls.push(args);
      return '';
    });
    await client.kill('deadbeef');
    expect(calls[0]).toEqual(['kill', 'deadbeef']);
  });

  it('getState returns null when inspect fails', async () => {
    const client = new CliDockerClient(async () => {
      throw new Error('no such container');
    });
    await expect(client.getState('nope')).resolves.toBeNull();
  });
});
