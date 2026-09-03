/**
 * An oracle embedder, for ablation only.
 *
 * **This is not a model and it never ships.** It builds vectors from the
 * ground-truth labels, so it knows the answer. Using it to claim clustering
 * quality would be circular.
 *
 * What it is legitimately for: measuring the **headroom of the architecture**.
 * Before spending effort on a real embedding model we should know whether the
 * pipeline downstream of it can even use a good semantic signal. Two questions
 * it answers that no amount of lexical tuning can:
 *
 *  1. With a *perfect* semantic signal, does the pipeline produce a correct
 *     ranked list? If not, embeddings are not the bottleneck and the effort
 *     should go elsewhere.
 *  2. How much signal degradation can the pipeline tolerate? Sweeping the
 *     noise level yields a curve, and that curve is the quality bar a real
 *     model has to clear — which is the difference between "any MiniLM will
 *     do" and "this needs a large model".
 *
 * Noise is interpolation toward a random direction, so `noise = 0` is a
 * perfect oracle and `noise = 1` is pure chance.
 */

import type { Embedder } from '../../aggregate/src/embed.ts';
import { normalizeDense } from '../../aggregate/src/embed.ts';

/**
 * mulberry32 — small, fast, deterministic.
 *
 * Seeded rather than `Math.random()` so an ablation is reproducible: a curve
 * that shifts between runs is unreadable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so vectors are drawn from a proper Gaussian rather than a cube. */
function gaussianVector(dimensions: number, rand: () => number): Float64Array {
  const v = new Float64Array(dimensions);
  for (let i = 0; i < dimensions; i += 2) {
    const u1 = Math.max(rand(), Number.EPSILON);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    v[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < dimensions) v[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return v;
}

export interface OracleOptions {
  /** 0 = perfect knowledge, 1 = pure noise. */
  noise: number;
  dimensions?: number;
  seed?: number;
}

/**
 * @param labelOf  maps a text back to its ground-truth cluster. The oracle
 *                 cheats through this function, which is why it is confined to
 *                 the eval package.
 */
export function createOracleEmbedder(
  labelOf: (text: string) => string,
  options: OracleOptions,
): Embedder {
  const dimensions = options.dimensions ?? 64;
  const noise = Math.min(1, Math.max(0, options.noise));
  const baseSeed = options.seed ?? 1;

  const clusterVectors = new Map<string, Float64Array>();
  let nextClusterSeed = baseSeed;

  function clusterVector(label: string): Float64Array {
    const existing = clusterVectors.get(label);
    if (existing !== undefined) return existing;
    const v = normalizeDense(gaussianVector(dimensions, mulberry32(nextClusterSeed++)));
    clusterVectors.set(label, v);
    return v;
  }

  // Per-text noise is seeded by content, so the same submission always gets
  // the same vector regardless of batch order or batch size.
  function textSeed(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) + baseSeed;
  }

  return {
    name: `oracle(noise=${noise.toFixed(2)})`,
    dimensions,
    embed: async (texts: readonly string[]): Promise<Float64Array[]> =>
      texts.map((text) => {
        const signal = clusterVector(labelOf(text));
        if (noise === 0) return signal;
        const perturbation = normalizeDense(gaussianVector(dimensions, mulberry32(textSeed(text))));
        const mixed = new Float64Array(dimensions);
        for (let i = 0; i < dimensions; i++) {
          mixed[i] = (1 - noise) * (signal[i] as number) + noise * (perturbation[i] as number);
        }
        return normalizeDense(mixed);
      }),
  };
}
