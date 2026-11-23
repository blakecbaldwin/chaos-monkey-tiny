import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('returns defaults for an empty object', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a full valid config', () => {
    const cfg = parseConfig({
      killProbability: 0.25,
      intervalSeconds: 45,
      healthEndpoints: { api: 'http://localhost:8081/health' },
      activeWindow: { start: '09:00', end: '17:00' },
      excludeNames: ['database'],
    });
    expect(cfg.killProbability).toBe(0.25);
    expect(cfg.intervalSeconds).toBe(45);
    expect(cfg.healthEndpoints).toEqual({ api: 'http://localhost:8081/health' });
    expect(cfg.activeWindow).toEqual({ start: '09:00', end: '17:00' });
    expect(cfg.excludeNames).toEqual(['database']);
  });

  it('rejects a non-object config', () => {
    expect(() => parseConfig([1, 2])).toThrow(ConfigError);
    expect(() => parseConfig('nope')).toThrow(ConfigError);
  });

  it('rejects an out-of-range kill probability and names the field', () => {
    try {
      parseConfig({ killProbability: 1.5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('killProbability');
    }
  });

  it('collects multiple problems in one error', () => {
    try {
      parseConfig({ killProbability: -1, intervalSeconds: 0, pollIntervalSeconds: -3 });
      expect.unreachable();
    } catch (err) {
      const problems = (err as ConfigError).problems;
      expect(problems).toHaveLength(3);
      expect(problems.join(' ')).toContain('killProbability');
      expect(problems.join(' ')).toContain('intervalSeconds');
      expect(problems.join(' ')).toContain('pollIntervalSeconds');
    }
  });

  it('rejects malformed active window times', () => {
    expect(() => parseConfig({ activeWindow: { start: '9am', end: '17:00' } })).toThrow(/activeWindow\.start/);
    expect(() => parseConfig({ activeWindow: { start: '09:00', end: '25:00' } })).toThrow(/activeWindow\.end/);
  });

  it('allows an explicit null active window', () => {
    expect(parseConfig({ activeWindow: null }).activeWindow).toBeNull();
  });

  it('rejects invalid health endpoint URLs', () => {
    expect(() => parseConfig({ healthEndpoints: { api: 'not a url' } })).toThrow(/healthEndpoints\.api/);
    expect(() => parseConfig({ healthEndpoints: { api: 'ftp://x/health' } })).toThrow(/healthEndpoints\.api/);
  });

  it('rejects excludeNames that are not strings', () => {
    expect(() => parseConfig({ excludeNames: [42] })).toThrow(/excludeNames/);
  });
});
