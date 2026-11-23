import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExperimentResult } from './engine.js';

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Render one experiment as a Markdown report. */
export function renderReport(result: ExperimentResult): string {
  const lines: string[] = [];
  lines.push('# Chaos experiment report');
  lines.push('');
  lines.push(`- Date: ${result.startedAt.toISOString()}`);
  lines.push(`- Mode: ${result.dryRun ? 'dry run (nothing was killed)' : 'live'}`);
  lines.push(`- Action: ${result.action}${result.skipReason ? ` (${result.skipReason})` : ''}`);
  lines.push('');
  lines.push('## Steady-state hypothesis');
  lines.push('');
  lines.push(result.hypothesis);
  lines.push('');
  lines.push('## Victim');
  lines.push('');
  if (result.victim) {
    lines.push(`- Name: ${result.victim.name}`);
    lines.push(`- Container ID: ${result.victim.id.slice(0, 12)}`);
    lines.push(`- Image: ${result.victim.image}`);
  } else {
    lines.push('No victim was selected.');
  }
  lines.push('');
  lines.push('## Health before the experiment');
  lines.push('');
  const before = Object.entries(result.healthBefore);
  if (before.length === 0) {
    lines.push('No health endpoints are configured.');
  } else {
    for (const [name, ok] of before) lines.push(`- ${name}: ${ok ? 'healthy' : 'UNHEALTHY'}`);
  }
  lines.push('');
  lines.push('## Health timeline after the kill');
  lines.push('');
  if (result.samples.length === 0) {
    lines.push('No recovery polling ran (dry run or skipped experiment).');
  } else {
    lines.push('| Time after kill | Healthy |');
    lines.push('| --- | --- |');
    for (const sample of result.samples) {
      lines.push(`| ${(sample.atMs / 1000).toFixed(1)}s | ${yesNo(sample.ok)} |`);
    }
  }
  lines.push('');
  lines.push('## Recovery');
  lines.push('');
  if (result.recovered === null) {
    lines.push('Not measured.');
  } else if (result.recovered) {
    lines.push(`Recovered in ${((result.recoveryMs ?? 0) / 1000).toFixed(1)}s.`);
  } else {
    lines.push('Did not recover within the recovery timeout.');
  }
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(result.verdict);
  lines.push('');
  return lines.join('\n');
}

/** Short console summary printed after each experiment. */
export function renderSummary(result: ExperimentResult): string {
  const lines: string[] = [];
  lines.push(`[chaos] experiment at ${result.startedAt.toISOString()} (${result.dryRun ? 'dry run' : 'LIVE'})`);
  if (result.victim) {
    lines.push(`[chaos] victim: ${result.victim.name} (${result.victim.id.slice(0, 12)})`);
  }
  lines.push(`[chaos] action: ${result.action}${result.skipReason ? ` (${result.skipReason})` : ''}`);
  if (result.recovered !== null) {
    lines.push(
      result.recovered
        ? `[chaos] recovered: yes, in ${((result.recoveryMs ?? 0) / 1000).toFixed(1)}s`
        : '[chaos] recovered: NO (timeout)',
    );
  }
  lines.push(`[chaos] verdict: ${result.verdict}`);
  return lines.join('\n');
}

/** Write the report under `dir` with a timestamped filename. Returns the path. */
export async function writeReport(dir: string, result: ExperimentResult): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = result.startedAt.toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `experiment-${stamp}.md`);
  await writeFile(path, renderReport(result), 'utf8');
  return path;
}
