import { describe, expect, it } from 'vitest';
import { binomCdf, bootstrapMeanCI, clopperPearson, passHatK, quantile, wilson } from '../../src/eval/stats.ts';

describe('statistics (Evaluation Plan §5)', () => {
  it('SX-01 Wilson interval matches reference values', () => {
    const [lo, hi] = wilson(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.2775, 4);
    const [l2, h2] = wilson(5, 10);
    expect(l2).toBeCloseTo(0.2366, 4);
    expect(h2).toBeCloseTo(0.7634, 4);
  });

  it('SX-02 Clopper–Pearson: zero events gives 1 − (α/2)^(1/n); interior matches reference', () => {
    expect(clopperPearson(0, 50)[1]).toBeCloseTo(1 - 0.025 ** (1 / 50), 6); // ≈ 0.0711
    expect(clopperPearson(0, 50)[1]).toBeCloseTo(0.0711, 4);
    const [lo, hi] = clopperPearson(5, 10);
    expect(lo).toBeCloseTo(0.1871, 3);
    expect(hi).toBeCloseTo(0.8129, 3);
    expect(clopperPearson(10, 10)[1]).toBe(1);
  });

  it('SX-03 binomial CDF is correct at the edges and in the middle', () => {
    expect(binomCdf(0, 3, 0.5)).toBeCloseTo(0.125, 10);
    expect(binomCdf(1, 3, 0.5)).toBeCloseTo(0.5, 10);
    expect(binomCdf(3, 3, 0.5)).toBe(1);
  });

  it('SX-04 pass^k follows the τ-bench estimator', () => {
    expect(passHatK([{ c: 2, n: 5 }], 2)).toBeCloseTo(0.1, 10); // C(2,2)/C(5,2)
    expect(passHatK([{ c: 5, n: 5 }, { c: 0, n: 5 }], 3)).toBeCloseTo(0.5, 10);
    expect(passHatK([{ c: 4, n: 5 }], 1)).toBeCloseTo(0.8, 10);
  });

  it('SX-05 quantile interpolates; bootstrap is seeded and brackets the mean', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const values = [0, 0, 1, 1, 1, 0, 1, 1, 0, 1];
    const a = bootstrapMeanCI(values, { seed: 7 });
    expect(bootstrapMeanCI(values, { seed: 7 })).toEqual(a);
    expect(a[0]).toBeLessThan(0.6);
    expect(a[1]).toBeGreaterThan(0.6);
  });
});
