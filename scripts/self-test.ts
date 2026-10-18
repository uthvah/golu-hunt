/**
 * Leave-one-source-out test of public/index.*:
 * for each doll and each of its sources (close-up, photo 03, photo 01), hide that
 * source's rows and query with them. Then query every background tile with its own
 * photo's tiles hidden, to estimate false positives.
 *
 *   npm run self-test                         uses the default thresholds
 *   npm run self-test -- --tau 0.6 --margin 0.04
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeIndex, score, decide, DEFAULT_DECIDE, type IndexMeta } from '../src/match';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const opts = { tau: arg('--tau', DEFAULT_DECIDE.tau), margin: arg('--margin', DEFAULT_DECIDE.margin), minVotes: arg('--votes', DEFAULT_DECIDE.minVotes) };

const meta: IndexMeta = JSON.parse(await readFile(join(ROOT, 'public/index.json'), 'utf8'));
const bin = await readFile(join(ROOT, 'public/index.bin'));
const index = decodeIndex(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
const { classes, dim, label, src, vecs } = index;
const nDolls = classes.length - 1;
const row = (r: number) => vecs.subarray(r * dim, (r + 1) * dim);
if (meta.model === 'mock') console.warn('\n⚠ This index was built with --mock: these numbers mean nothing.\n');

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '  - ');

// confusion[true][predicted]; predicted index nDolls = "none"
const confusion = Array.from({ length: nDolls }, () => new Array(nDolls + 1).fill(0));
const correctS1: number[] = [];
const perDollS1: number[][] = Array.from({ length: nDolls }, () => []);

for (let c = 0; c < nDolls; c++) {
  const sources = [...new Set(meta.src.filter((_, r) => label[r] === c))];
  for (const s of sources) {
    const hide = (r: number) => label[r] === c && src[r] === s;
    for (let r = 0; r < index.count; r++) {
      if (!hide(r)) continue;
      const sc = score(index, row(r), 7, hide);
      const d = decide(index, sc, opts);
      const p = d ? classes.indexOf(d) : nDolls;
      confusion[c][p]++;
      perDollS1[c].push(sc.best[c]);
      if (p === c) correctS1.push(sc.s1);
    }
  }
}

// false positives from background tiles
const bgS1: number[] = [];
let bgQueries = 0, bgFalse = 0;
for (let r = 0; r < index.count; r++) {
  if (label[r] !== index.bg) continue;
  const s = src[r];
  const sc = score(index, row(r), 7, (i) => src[i] === s);
  bgQueries++;
  let bestDoll = -1;
  for (let c = 0; c < nDolls; c++) bestDoll = Math.max(bestDoll, sc.best[c]);
  bgS1.push(bestDoll);
  if (decide(index, sc, opts)) bgFalse++;
}

console.log(`thresholds: tau ${opts.tau}, margin ${opts.margin}, votes ≥ ${opts.minVotes}/7\n`);
const head = ['true \\ pred', ...classes.slice(0, nDolls).map((c) => c.slice(0, 5)), 'none', 'acc'];
console.log(head[0].padEnd(12) + head.slice(1).map((h) => h.padStart(7)).join(''));
let tot = 0, ok = 0;
confusion.forEach((rowC, c) => {
  const n = rowC.reduce((a, b) => a + b, 0);
  tot += n; ok += rowC[c];
  console.log(classes[c].padEnd(12) + [...rowC.map(String), `${((100 * rowC[c]) / n).toFixed(0)}%`].map((x) => x.padStart(7)).join(''));
});
console.log(`\noverall top-1 accuracy: ${((100 * ok) / tot).toFixed(1)}%   (target ≥ 90%)`);
console.log(`background tiles wrongly accepted as a doll: ${bgFalse}/${bgQueries} (${((100 * bgFalse) / bgQueries).toFixed(1)}%)`);

console.log('\nsimilarity to own class (p10 / median), per doll:');
perDollS1.forEach((xs, c) => console.log(`  ${classes[c].padEnd(11)} ${f2(pct(xs, 0.1))} / ${f2(pct(xs, 0.5))}`));
const lo = pct(correctS1, 0.1), hi = pct(bgS1, 0.95);
console.log(`\ncorrect matches s1 p10: ${f2(lo)}   background best-doll p95: ${f2(hi)}`);
if (lo > hi) console.log(`suggested starting tau ≈ ${f2((lo + hi) / 2)} (midpoint). Re-tune live in debug mode.`);
else console.log('positives and background overlap: tighten the boxes or add more reference views before trusting tau.');

const worst = confusion.flatMap((r, c) => r.slice(0, nDolls).map((n, p) => ({ c, p, n: p === c ? 0 : n / r.reduce((a, b) => a + b, 0) }))).sort((a, b) => b.n - a.n)[0];
if (worst && worst.n > 0.05) console.log(`⚠ ${classes[worst.c]} is mistaken for ${classes[worst.p]} ${(100 * worst.n).toFixed(0)}% of the time (limit 5%).`);
