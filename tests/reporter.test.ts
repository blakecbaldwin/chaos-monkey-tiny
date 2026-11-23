import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExperimentResult } from '../src/engine.js';
import { renderReport, renderSummary, writeReport } from '../src/reporter.js';

function sampleResult(partial: Partial<ExperimentResult> = {}): ExperimentResult {
  return {
    startedAt: new Date('2026-11-23T15:04:05.000Z'),
    dryRun: false,
    hypothesis: 'Steady state holds and the service recovers on its own.',
    victim: {
      id: 'abcdef1234567890',
      name: 'proj-resilient-api-1',
      image: 'demo:latest',
      state: 'running',
      labels: { 'chaos.enabled': 'true' },
    },
    action: 'killed',
    skipReason: null,
    healthBefore: { 'resilient-api': true, 'fragile-api': true },
    recovered: true,
    recoveryMs: 2000,
    samples: [
      { atMs: 0, ok: false },
      { atMs: 1000, ok: false },
      { atMs: 2000, ok: true },
    ],
    verdict: 'Hypothesis held: proj-resilient-api-1 recovered in 2.0s.',
    ...partial,
  };
}

describe('renderReport', () => {
  it('includes the hypothesis, victim, timeline, recovery, and verdict', () => {
    const report = renderReport(sampleResult());
    expect(report).toContain('# Chaos experiment report');
    expect(report).toContain('## Steady-state hypothesis');
    expect(report).toContain('proj-resilient-api-1');
    expect(report).toContain('abcdef123456');
    expect(report).toContain('| 2.0s | yes |');
    expect(report).toContain('Recovered in 2.0s.');
    expect(report).toContain('Hypothesis held');
    expect(report).toContain('- resilient-api: healthy');
  });

  it('renders a dry run honestly', () => {
    const report = renderReport(
      sampleResult({
        dryRun: true,
        action: 'would-kill',
        recovered: null,
        recoveryMs: null,
        samples: [],
        verdict: 'Dry run: nothing was killed.',
      }),
    );
    expect(report).toContain('dry run (nothing was killed)');
    expect(report).toContain('No recovery polling ran');
    expect(report).toContain('Not measured.');
  });

  it('renders a non-recovery', () => {
    const report = renderReport(
      sampleResult({ recovered: false, recoveryMs: null, verdict: 'Hypothesis violated.' }),
    );
    expect(report).toContain('Did not recover within the recovery timeout.');
  });
});

describe('renderSummary', () => {
  it('summarizes victim, action, and recovery in a few lines', () => {
    const summary = renderSummary(sampleResult());
    expect(summary).toContain('victim: proj-resilient-api-1');
    expect(summary).toContain('action: killed');
    expect(summary).toContain('recovered: yes, in 2.0s');
  });
});

describe('writeReport', () => {
  it('writes a timestamped Markdown file and returns its path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chaos-reports-'));
    const path = await writeReport(dir, sampleResult());
    expect(path).toContain('experiment-2026-11-23T15-04-05');
    expect(path.endsWith('.md')).toBe(true);
    const contents = await readFile(path, 'utf8');
    expect(contents).toContain('# Chaos experiment report');
  });
});
