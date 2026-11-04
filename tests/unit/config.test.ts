import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, fixtureSeedFromEnv } from '../../fixtures/generate.ts';
import { assertLocalDatabase, assertNotProduction, parsePort } from '../../src/config.ts';

describe('destructive-tool guards', () => {
  it('CF-01 only local database hosts are accepted', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() => assertLocalDatabase(`postgres://u:p@${host}:5432/arl_dev`, 'x')).not.toThrow();
    }
    for (const url of ['postgres://u:p@db.internal:5432/arl', 'postgres://u:p@10.0.0.5/arl', 'postgres://u:p@localhost.evil.com/arl', 'not a url']) {
      expect(() => assertLocalDatabase(url, 'x'), url).toThrow();
    }
  });

  it('CF-02 production is refused', () => {
    expect(() => assertNotProduction('production', 'x')).toThrow();
    expect(() => assertNotProduction('development', 'x')).not.toThrow();
  });

  it('CF-04 ports default when unset or empty and are range-checked otherwise', () => {
    expect(parsePort({}, 'P', 3101)).toBe(3101);
    expect(parsePort({ P: '' }, 'P', 3101)).toBe(3101);
    expect(parsePort({ P: '3200' }, 'P', 3101)).toBe(3200);
    for (const bad of ['0', '65536', '31o1', '-1', '3.5', ' 80']) expect(() => parsePort({ P: bad }, 'P', 1), bad).toThrow();
  });

  it('CF-03 FIXTURE_SEED accepts decimal integers only', () => {
    expect(fixtureSeedFromEnv({})).toBe(DEFAULT_SEED);
    expect(fixtureSeedFromEnv({ FIXTURE_SEED: '' })).toBe(DEFAULT_SEED);
    expect(fixtureSeedFromEnv({ FIXTURE_SEED: '7' })).toBe(7);
    for (const bad of ['0x10', '-1', '1e3', '1.5', ' 7', 'abc']) {
      expect(() => fixtureSeedFromEnv({ FIXTURE_SEED: bad }), bad).toThrow();
    }
  });
});
