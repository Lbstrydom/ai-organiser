/**
 * @fileoverview Seedable RNG for deterministic testing of stochastic components.
 * Production uses Math.random(); tests inject a seeded xorshift128 PRNG.
 * @module scripts/lib/rng
 */

// ── Pure JS Beta distribution sampling ──────────────────────────────────────

/** Standard normal random variate (Box-Muller). */
function randnWith(randomFn) {
  let u1;
  do { u1 = randomFn(); } while (u1 === 0);
  const u2 = randomFn();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma random variate (Marsaglia-Tsang). */
function randomGammaWith(shape, randomFn) {
  if (shape < 1) return randomGammaWith(shape + 1, randomFn) * Math.pow(randomFn(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = randnWith(randomFn); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = randomFn();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta random variate via Gamma decomposition. */
function randomBetaWith(alpha, beta, randomFn) {
  const g1 = randomGammaWith(alpha, randomFn);
  const g2 = randomGammaWith(beta, randomFn);
  return g1 / (g1 + g2);
}

/**
 * Create an RNG interface. Production uses Math.random(); tests inject a seed.
 * @param {number|null} seed - null for production (Math.random), number for deterministic
 * @returns {{ random: () => number, beta: (alpha: number, beta: number) => number }}
 */
export function createRNG(seed = null) {
  if (seed === null) {
    return {
      random: () => Math.random(),
      beta: (alpha, beta) => randomBetaWith(alpha, beta, Math.random)
    };
  }

  // Seedable xorshift128 for deterministic tests
  let s = [seed >>> 0, (seed ^ 0x12345678) >>> 0, (seed ^ 0x9ABCDEF0) >>> 0, (seed ^ 0xDEADBEEF) >>> 0];
  function next() {
    let t = s[3];
    t ^= t << 11; t ^= t >>> 8;
    s[3] = s[2]; s[2] = s[1]; s[1] = s[0];
    t ^= s[0]; t ^= s[0] >>> 19;
    s[0] = t;
    return (t >>> 0) / 0x100000000;
  }

  return {
    random: next,
    beta: (alpha, beta) => randomBetaWith(alpha, beta, next)
  };
}

/**
 * Reservoir sampling — uniform random from array using injected RNG.
 * @param {any[]} items - Source array
 * @param {number} k - Number of items to sample
 * @param {{ random: () => number }} rng - RNG interface
 * @returns {any[]} Sampled items (up to k)
 */
export function reservoirSample(items, k, rng = { random: Math.random }) {
  const reservoir = [];
  for (let i = 0; i < items.length; i++) {
    if (i < k) {
      reservoir.push(items[i]);
    } else {
      const j = Math.floor(rng.random() * (i + 1));
      if (j < k) reservoir[j] = items[i];
    }
  }
  return reservoir;
}
