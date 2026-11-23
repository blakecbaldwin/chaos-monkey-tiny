import { readFile } from 'node:fs/promises';

export interface ActiveWindow {
  /** 24h "HH:MM", local time. */
  start: string;
  /** 24h "HH:MM", local time. If earlier than start, the window wraps past midnight. */
  end: string;
}

export interface ChaosConfig {
  /** Docker label key a container must carry to be eligible as a victim. */
  labelKey: string;
  /** Docker label value the key must have. */
  labelValue: string;
  /** Chance (0 to 1) that a scheduled tick actually kills its chosen victim. */
  killProbability: number;
  /** Seconds between experiments in daemon mode. */
  intervalSeconds: number;
  /** Map of service name to HTTP health URL. Keys match a container name, its chaos.service label, or a substring of the container name. */
  healthEndpoints: Record<string, string>;
  /** How long to wait for a killed service to come back before calling it unrecovered. */
  recoveryTimeoutSeconds: number;
  /** Seconds between health polls while waiting for recovery. */
  pollIntervalSeconds: number;
  /** Local hours during which experiments may run, or null for no restriction. */
  activeWindow: ActiveWindow | null;
  /** Container names that are never eligible, no matter their labels. */
  excludeNames: string[];
  /** Directory where Markdown experiment reports are written. */
  reportsDir: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid chaos config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_CONFIG: ChaosConfig = {
  labelKey: 'chaos.enabled',
  labelValue: 'true',
  killProbability: 0.5,
  intervalSeconds: 60,
  healthEndpoints: {},
  recoveryTimeoutSeconds: 30,
  pollIntervalSeconds: 1,
  activeWindow: null,
  excludeNames: [],
  reportsDir: 'reports',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate raw parsed JSON into a ChaosConfig, collecting every problem so the
 * user can fix the file in one pass instead of one error at a time.
 */
export function parseConfig(raw: unknown): ChaosConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError(['config must be a JSON object']);
  }

  const problems: string[] = [];
  const cfg: ChaosConfig = {
    ...DEFAULT_CONFIG,
    healthEndpoints: {},
    excludeNames: [],
  };

  if (raw.labelKey !== undefined) {
    if (typeof raw.labelKey === 'string' && raw.labelKey.length > 0) cfg.labelKey = raw.labelKey;
    else problems.push('labelKey must be a non-empty string');
  }

  if (raw.labelValue !== undefined) {
    if (typeof raw.labelValue === 'string') cfg.labelValue = raw.labelValue;
    else problems.push('labelValue must be a string');
  }

  if (raw.killProbability !== undefined) {
    if (typeof raw.killProbability === 'number' && raw.killProbability >= 0 && raw.killProbability <= 1) {
      cfg.killProbability = raw.killProbability;
    } else {
      problems.push('killProbability must be a number between 0 and 1');
    }
  }

  if (raw.intervalSeconds !== undefined) {
    if (typeof raw.intervalSeconds === 'number' && raw.intervalSeconds > 0) cfg.intervalSeconds = raw.intervalSeconds;
    else problems.push('intervalSeconds must be a positive number');
  }

  if (raw.recoveryTimeoutSeconds !== undefined) {
    if (typeof raw.recoveryTimeoutSeconds === 'number' && raw.recoveryTimeoutSeconds > 0) {
      cfg.recoveryTimeoutSeconds = raw.recoveryTimeoutSeconds;
    } else {
      problems.push('recoveryTimeoutSeconds must be a positive number');
    }
  }

  if (raw.pollIntervalSeconds !== undefined) {
    if (typeof raw.pollIntervalSeconds === 'number' && raw.pollIntervalSeconds > 0) {
      cfg.pollIntervalSeconds = raw.pollIntervalSeconds;
    } else {
      problems.push('pollIntervalSeconds must be a positive number');
    }
  }

  if (raw.healthEndpoints !== undefined) {
    if (!isPlainObject(raw.healthEndpoints)) {
      problems.push('healthEndpoints must be an object mapping service names to health URLs');
    } else {
      for (const [name, url] of Object.entries(raw.healthEndpoints)) {
        if (typeof url !== 'string') {
          problems.push(`healthEndpoints.${name} must be a URL string`);
          continue;
        }
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            problems.push(`healthEndpoints.${name} must use http or https, got "${url}"`);
            continue;
          }
          cfg.healthEndpoints[name] = url;
        } catch {
          problems.push(`healthEndpoints.${name} is not a valid URL: "${url}"`);
        }
      }
    }
  }

  if (raw.activeWindow !== undefined && raw.activeWindow !== null) {
    if (!isPlainObject(raw.activeWindow)) {
      problems.push('activeWindow must be an object like {"start": "09:00", "end": "17:00"} or null');
    } else {
      const { start, end } = raw.activeWindow;
      const startOk = typeof start === 'string' && TIME_PATTERN.test(start);
      const endOk = typeof end === 'string' && TIME_PATTERN.test(end);
      if (!startOk) problems.push('activeWindow.start must be a 24h "HH:MM" time');
      if (!endOk) problems.push('activeWindow.end must be a 24h "HH:MM" time');
      if (startOk && endOk) cfg.activeWindow = { start: start as string, end: end as string };
    }
  }

  if (raw.excludeNames !== undefined) {
    if (Array.isArray(raw.excludeNames) && raw.excludeNames.every((n) => typeof n === 'string')) {
      cfg.excludeNames = [...raw.excludeNames];
    } else {
      problems.push('excludeNames must be an array of container name strings');
    }
  }

  if (raw.reportsDir !== undefined) {
    if (typeof raw.reportsDir === 'string' && raw.reportsDir.length > 0) cfg.reportsDir = raw.reportsDir;
    else problems.push('reportsDir must be a non-empty string');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}

export async function loadConfig(path: string): Promise<ChaosConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError([`could not read config file at ${path}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`config file is not valid JSON: ${(err as Error).message}`]);
  }
  return parseConfig(raw);
}
