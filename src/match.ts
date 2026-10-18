// Reference index + scoring. Pure functions, shared by the browser worker and
// scripts/self-test.ts so the offline numbers mean the same thing as live ones.

export type Stair = 0 | 1 | 2; // left, middle, right
export interface Loc { x: number; y: number; stair: Stair }

export interface IndexMeta {
  version: 1;
  model: string;
  dtype: string;
  dim: number;
  count: number;
  classes: string[]; // doll ids..., then 'bg' last
  label: number[];   // class index per row
  src: string[];     // photo id per row ('05', '03', 'tile-03', ...)
  loc: (number[] | null)[]; // [x, y, stair] in photo-03 coordinates
}

export interface RefIndex {
  dim: number;
  count: number;
  classes: string[];
  bg: number;
  label: Uint16Array;
  src: string[];
  loc: (Loc | null)[];
  vecs: Float32Array; // count * dim, rows L2-normalised
}

export const QUANT_SCALE = 127;

export function quantise(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * QUANT_SCALE)));
  }
  return q;
}

export function decodeIndex(meta: IndexMeta, bin: ArrayBuffer): RefIndex {
  const q = new Int8Array(bin);
  if (q.length !== meta.count * meta.dim) {
    throw new Error(`index.bin has ${q.length} values, expected ${meta.count * meta.dim}`);
  }
  const vecs = new Float32Array(q.length);
  for (let r = 0; r < meta.count; r++) {
    let s = 0;
    const o = r * meta.dim;
    for (let j = 0; j < meta.dim; j++) {
      const x = q[o + j] / QUANT_SCALE;
      vecs[o + j] = x;
      s += x * x;
    }
    const inv = 1 / Math.sqrt(s || 1);
    for (let j = 0; j < meta.dim; j++) vecs[o + j] *= inv;
  }
  return {
    dim: meta.dim,
    count: meta.count,
    classes: meta.classes,
    bg: meta.classes.indexOf('bg'),
    label: Uint16Array.from(meta.label),
    src: meta.src,
    loc: meta.loc.map((l) => (l ? { x: l[0], y: l[1], stair: l[2] as Stair } : null)),
    vecs,
  };
}

export interface Neighbour { i: number; s: number }

export interface Scored {
  top: number;        // class index with the highest best-match similarity
  s1: number;         // that similarity
  second: number;     // runner-up class
  s2: number;
  votes: number;      // how many of the k nearest rows share `top`
  neighbours: Neighbour[];
  best: Float32Array; // best similarity per class
}

/** Full scan: per-class best similarity plus the k nearest rows. */
export function score(
  index: RefIndex,
  q: Float32Array,
  k = 7,
  skip?: (row: number) => boolean,
): Scored {
  const { dim, count, vecs, label } = index;
  const nc = index.classes.length;
  const best = new Float32Array(nc).fill(-2);
  const nn: Neighbour[] = [];
  for (let r = 0; r < count; r++) {
    if (skip && skip(r)) continue;
    let s = 0;
    const o = r * dim;
    for (let j = 0; j < dim; j++) s += vecs[o + j] * q[j];
    const c = label[r];
    if (s > best[c]) best[c] = s;
    if (nn.length < k) nn.push({ i: r, s });
    else if (s > nn[k - 1].s) nn[k - 1] = { i: r, s };
    else continue;
    for (let p = nn.length - 1; p > 0 && nn[p - 1].s < nn[p].s; p--) {
      const t = nn[p]; nn[p] = nn[p - 1]; nn[p - 1] = t;
    }
  }
  let top = 0, second = -1;
  for (let c = 1; c < nc; c++) if (best[c] > best[top]) top = c;
  for (let c = 0; c < nc; c++) if (c !== top && (second < 0 || best[c] > best[second])) second = c;
  let votes = 0;
  for (const n of nn) if (label[n.i] === top) votes++;
  return { top, s1: best[top], second, s2: second >= 0 ? best[second] : -1, votes, neighbours: nn, best };
}

export interface DecideOptions { tau: number; margin: number; minVotes: number }
export const DEFAULT_DECIDE: DecideOptions = { tau: 0.55, margin: 0.05, minVotes: 4 };

/** The doll id this single frame votes for, or null. */
export function decide(index: RefIndex, sc: Scored, o: DecideOptions = DEFAULT_DECIDE): string | null {
  if (sc.top === index.bg) return null;
  if (sc.s1 < o.tau) return null;
  if (sc.s1 - sc.s2 < o.margin) return null;
  if (sc.votes < o.minVotes) return null;
  return index.classes[sc.top];
}

/** Confirms a doll once it wins `need` of the last `size` frames. */
export class Stabiliser {
  private buf: (string | null)[] = [];
  constructor(private size = 7, private need = 5) {}
  push(v: string | null): string | null {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
    const counts = new Map<string, number>();
    for (const x of this.buf) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
    for (const [id, n] of counts) if (n >= this.need) return id;
    return null;
  }
  reset(): void { this.buf = []; }
}
