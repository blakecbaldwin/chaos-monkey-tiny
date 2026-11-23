#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { CliDockerClient } from './docker.js';
import { ChaosEngine, type ExperimentResult } from './engine.js';
import { HttpHealthChecker } from './health.js';
import { renderSummary, writeReport } from './reporter.js';

export interface CliOptions {
  configPath: string;
  live: boolean;
  once: boolean;
  selfName: string | null;
}

function printHelp(): void {
  console.log(`chaos-monkey-tiny: run chaos experiments against a local Docker Compose stack.

Usage:
  chaos-monkey [--config chaos.config.json] [--once] [--live] [--self <name>]

Modes:
  (default)   Daemon mode: run an experiment every intervalSeconds from the config.
  --once      Run a single experiment and exit. Best for demos and CI.

Safety:
  Dry run is the DEFAULT. The monkey logs what it would kill and kills nothing.
  --live      Actually kill containers. Without this flag, nothing is ever killed.
  --dry-run   Force dry run (this is already the default).
  --self      Name of the monkey's own container, which is never targeted.
              Can also be set with the CHAOS_SELF_NAME environment variable.
`);
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    configPath: 'chaos.config.json',
    live: false,
    once: false,
    selfName: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') opts.live = true;
    else if (arg === '--dry-run') opts.live = false;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--config') {
      const value = argv[i + 1];
      if (!value) throw new Error('--config needs a path');
      opts.configPath = value;
      i += 1;
    } else if (arg === '--self') {
      const value = argv[i + 1];
      if (!value) throw new Error('--self needs a container name');
      opts.selfName = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg} (try --help)`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadConfig(opts.configPath);

  const engine = new ChaosEngine({
    docker: new CliDockerClient(),
    health: new HttpHealthChecker(),
    config,
    selfName: opts.selfName ?? process.env.CHAOS_SELF_NAME ?? null,
    log: (message) => console.log(`[chaos] ${message}`),
  });

  const handle = async (result: ExperimentResult): Promise<void> => {
    console.log(renderSummary(result));
    const path = await writeReport(config.reportsDir, result);
    console.log(`[chaos] report written to ${path}`);
  };

  if (opts.once) {
    await handle(await engine.runOnce({ live: opts.live }));
    return;
  }

  console.log(
    `[chaos] daemon mode: an experiment every ${config.intervalSeconds}s, ` +
      `${opts.live ? 'LIVE kills' : 'dry run (pass --live to actually kill)'}. Ctrl-C to stop.`,
  );
  process.on('SIGINT', () => engine.stop());
  process.on('SIGTERM', () => engine.stop());
  await engine.runDaemon({ live: opts.live, onExperiment: handle });
}

main().catch((err: Error) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(`chaos-monkey failed: ${err.message}`);
  process.exit(1);
});
