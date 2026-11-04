// Small, dependency-free statistics for Evaluation Plan §5. Exactness matters more than
// speed here: n is tens to hundreds.

/** Wilson score interval for a binomial proportion. */
export function wilson(x: number, n: number, z = 1.959964): [number, number] {
  if (n === 0) return [0, 1];
  const p = x / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X <= x) for X ~ Binomial(n, p). */
export function binomCdf(x: number, n: number, p: number): number {
  if (x < 0) return 0;
  if (x >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let total = 0;
  for (let i = 0; i <= x; i++) total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, total);
}

function bisect(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if (increasing ? v < target : v > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Exact (Clopper–Pearson) two-sided interval. For x = 0 the upper bound is 1 − (α/2)^(1/n). */
export function clopperPearson(x: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const lower = x === 0 ? 0 : bisect((p) => 1 - binomCdf(x - 1, n, p), alpha / 2, true);
  const upper = x === n ? 1 : bisect((p) => binomCdf(x, n, p), alpha / 2, false);
  return [lower, upper];
}

function choose(n: number, k: number): number {
  return k < 0 || k > n ? 0 : Math.exp(logChoose(n, k));
}

/** τ-bench pass^k = mean over cases of C(c, k) / C(n, k). */
export function passHatK(perCase: { c: number; n: number }[], k: number): number {
  if (perCase.length === 0) return 0;
  return perCase.reduce((sum, { c, n }) => sum + (n >= k ? choose(c, k) / choose(n, k) : 0), 0) / perCase.length;
}

/** Linear-interpolation quantile (type 7) of a sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/** Percentile bootstrap CI of the mean, resampling cases (the unit of analysis, §5). */
export function bootstrapMeanCI(values: number[], { resamples = 10_000, seed = 1, alpha = 0.05 } = {}): [number, number] {
  if (values.length === 0) return [Number.NaN, Number.NaN];
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[Math.floor(rand() * values.length)] as number;
    means.push(s / values.length);
  }
  means.sort((x, y) => x - y);
  return [quantile(means, alpha / 2), quantile(means, 1 - alpha / 2)];
}
