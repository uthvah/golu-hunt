/**
 * Builds the reference index from data/photos + data/boxes.json.
 *
 *   npm run build-index              full build (downloads the model once, ~25 MB)
 *   npm run build-index -- --assets  only the story crops + photo-mode image (no model)
 *   npm run build-index -- --mock    pipeline test with a fake embedder (no model, useless for play)
 *   npm run build-index -- --preview write build/preview/<id>.png to eyeball the augmentation
 *
 * Outputs: public/index.bin, public/index.json, public/crops/*.jpg, public/golu-middle.jpg
 */
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT, DIM, MODEL_ID, loadModel, embed, l2normalise } from '../src/embed';
import { quantise, type IndexMeta } from '../src/match';
import { fromPhoto01, fromPhoto03 } from '../src/locate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS = join(ROOT, 'data/photos');
const OUT = join(ROOT, 'public');
const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const ASSETS_ONLY = args.has('--assets');
const PER_SOURCE = 40;
const MIN_SOURCE_PX = 48; // skip positive sources smaller than this (short side)
const DTYPE = 'q8' as const;

interface BoxRow { id: string; photo: string; box: [number, number, number, number] }
type Box = [number, number, number, number];

const boxes: BoxRow[] = JSON.parse(await readFile(join(ROOT, 'data/boxes.json'), 'utf8')).boxes;
const targets: { id: string }[] = JSON.parse(await readFile(join(ROOT, 'data/targets.json'), 'utf8')).targets;
const ids = targets.map((t) => t.id);
const WIDE = new Set(['01', '03']);

// ---------- deterministic randomness ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------- image helpers ----------
const meta = new Map<string, { w: number; h: number }>();
async function size(photo: string) {
  if (!meta.has(photo)) {
    const m = await sharp(join(PHOTOS, `${photo}.jpg`)).rotate().metadata();
    const w = m.autoOrient?.width ?? m.width!, h = m.autoOrient?.height ?? m.height!;
    meta.set(photo, { w, h });
  }
  return meta.get(photo)!;
}

async function cropPx(photo: string, b: Box, pad: number, square = false) {
  const { w, h } = await size(photo);
  const bw = (b[2] - b[0]) * w, bh = (b[3] - b[1]) * h;
  if (square) {
    // Square around the box centre, like the live reticle crop; context fills the short side.
    const side = Math.round(Math.min(Math.max(bw, bh) * (1 + 2 * pad), w, h));
    const cx = ((b[0] + b[2]) / 2) * w, cy = ((b[1] + b[3]) / 2) * h;
    const left = Math.round(Math.min(Math.max(0, cx - side / 2), w - side));
    const top = Math.round(Math.min(Math.max(0, cy - side / 2), h - side));
    return { left, top, width: side, height: side };
  }
  const left = Math.max(0, Math.round(b[0] * w - bw * pad));
  const top = Math.max(0, Math.round(b[1] * h - bh * pad));
  const right = Math.min(w, Math.round(b[2] * w + bw * pad));
  const bottom = Math.min(h, Math.round(b[3] * h + bh * pad));
  return { left, top, width: right - left, height: bottom - top };
}

const rawCache = new Map<string, { data: Buffer; w: number; h: number }>();
async function raw(photo: string) {
  if (!rawCache.has(photo)) {
    const { data, info } = await sharp(join(PHOTOS, `${photo}.jpg`)).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    rawCache.set(photo, { data, w: info.width, h: info.height });
  }
  return rawCache.get(photo)!;
}
async function extractPng(photo: string, r: { left: number; top: number; width: number; height: number }) {
  const { data, w, h } = await raw(photo);
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).extract(r).png({ compressionLevel: 0 }).toBuffer();
}

/** Augment from at most 512 px: plenty for a 224 px input, and much faster. */
async function shrink(img: Buffer): Promise<Buffer> {
  return sharp(img).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 0 }).toBuffer();
}

async function toInput(img: Buffer): Promise<Buffer> {
  return sharp(img).resize(INPUT, INPUT, { fit: 'fill' }).removeAlpha().raw().toBuffer();
}

/** One augmented 224x224 RGB view of `img` (identity when rnd is null). */
async function augment(img: Buffer, rnd: (() => number) | null): Promise<Buffer> {
  if (!rnd) return toInput(img);
  const m = await sharp(img).metadata();
  const w = m.width!, h = m.height!;
  // random resized crop: 55–100% of the area, aspect 0.8–1.25
  const area = lerp(0.55, 1, rnd());
  const ar = Math.exp(lerp(Math.log(0.8), Math.log(1.25), rnd()));
  const cw = Math.max(16, Math.min(w, Math.round(w * Math.sqrt(area * ar))));
  const ch = Math.max(16, Math.min(h, Math.round(h * Math.sqrt(area / ar))));
  const cx = Math.floor(rnd() * (w - cw + 1)), cy = Math.floor(rnd() * (h - ch + 1));
  let buf = await sharp(img).extract({ left: cx, top: cy, width: cw, height: ch }).png({ compressionLevel: 0 }).toBuffer();

  // rotation ±12° combined with a shear of up to 0.15 (stand-in for viewpoint change)
  const a = (lerp(-12, 12, rnd()) * Math.PI) / 180;
  const sx = lerp(-0.15, 0.15, rnd()), sy = lerp(-0.08, 0.08, rnd());
  const c = Math.cos(a), s = Math.sin(a);
  const M: [number, number, number, number] = [c + -s * sy, c * sx - s, s + c * sy, s * sx + c];
  const { data, info } = await sharp(buf)
    .affine(M, { background: { r: 120, g: 30, b: 34 }, interpolator: sharp.interpolators.bilinear })
    .png()
    .toBuffer({ resolveWithObject: true });
  const kw = Math.round(info.width * 0.78), kh = Math.round(info.height * 0.78);
  buf = await sharp(data)
    .extract({ left: Math.round((info.width - kw) / 2), top: Math.round((info.height - kh) / 2), width: kw, height: kh })
    .png()
    .toBuffer();

  // photometric: brightness ±25%, saturation ±20%, hue ±5°, contrast ±20%, blur σ 0–1.5
  const contrast = lerp(0.8, 1.2, rnd());
  const sigma = rnd() * 1.5;
  let p = sharp(buf)
    .modulate({ brightness: lerp(0.75, 1.25, rnd()), saturation: lerp(0.8, 1.2, rnd()), hue: Math.round(lerp(-5, 5, rnd())) })
    .linear(contrast, 128 * (1 - contrast));
  if (sigma >= 0.3) p = p.blur(sigma);
  buf = await p.png().toBuffer();

  // distance: shrink to 30–100% of input size, then JPEG at quality 50–90
  const small = Math.max(32, Math.round(INPUT * lerp(0.3, 1, rnd())));
  buf = await sharp(buf).resize(small, small, { fit: 'fill' }).jpeg({ quality: Math.round(lerp(50, 90, rnd())) }).toBuffer();
  return toInput(buf);
}

// ---------- embedders ----------
type Embedder = (rgb: Buffer) => Promise<Float32Array>;
function mockEmbedder(): Embedder {
  // Fixed random projection of an 8x8 thumbnail. Only for testing the pipeline.
  const rnd = mulberry32(42);
  const P = new Float32Array(DIM * 192).map(() => rnd() * 2 - 1);
  return async (rgb) => {
    const t = await sharp(rgb, { raw: { width: INPUT, height: INPUT, channels: 3 } }).resize(8, 8).raw().toBuffer();
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) { let s = 0; for (let j = 0; j < 192; j++) s += P[i * 192 + j] * (t[j] / 255 - 0.5); v[i] = s; }
    return l2normalise(v);
  };
}

// ---------- assets for the site ----------
async function writeAssets() {
  await mkdir(join(OUT, 'crops'), { recursive: true });
  for (const id of ids) {
    const b = boxes.find((x) => x.id === id && !WIDE.has(x.photo));
    if (!b) throw new Error(`No close-up box for ${id}`);
    const r = await cropPx(b.photo, b.box, 0.06);
    await sharp(join(PHOTOS, `${b.photo}.jpg`)).rotate().extract(r)
      .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(join(OUT, 'crops', `${id}.jpg`));
  }
  await sharp(join(PHOTOS, '03.jpg')).rotate().resize({ width: 1536, withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true }).toFile(join(OUT, 'golu-middle.jpg'));
  console.log(`assets: ${ids.length} crops + golu-middle.jpg`);
}

// ---------- index ----------
const overlapOf = (t: Box, b: Box) => {
  const ix = Math.max(0, Math.min(t[2], b[2]) - Math.max(t[0], b[0]));
  const iy = Math.max(0, Math.min(t[3], b[3]) - Math.max(t[1], b[1]));
  return (ix * iy) / ((b[2] - b[0]) * (b[3] - b[1]));
};

async function tiles(photo: string, sizes: number[]) {
  const { w, h } = await size(photo);
  const own = boxes.filter((b) => b.photo === photo).map((b) => b.box);
  const out: { r: { left: number; top: number; width: number; height: number }; cx: number; cy: number }[] = [];
  for (const f of sizes) {
    const s = Math.round(w * f), step = Math.round(s / 2);
    for (let y = 0; y + s <= h; y += step) {
      for (let x = 0; x + s <= w; x += step) {
        const t: Box = [x / w, y / h, (x + s) / w, (y + s) / h];
        if (own.some((b) => overlapOf(t, b) > 0.2)) continue;
        out.push({ r: { left: x, top: y, width: s, height: s }, cx: (x + s / 2) / w, cy: (y + s / 2) / h });
      }
    }
  }
  return out;
}

async function buildIndex(embedFn: Embedder) {
  const classes = [...ids, 'bg'];
  const vecs: Int8Array[] = [];
  const m: IndexMeta = { version: 1, model: MOCK ? 'mock' : MODEL_ID, dtype: MOCK ? 'mock' : DTYPE, dim: DIM, count: 0, classes, label: [], src: [], loc: [] };
  const add = (v: Float32Array, label: number, src: string, loc: number[] | null) => {
    vecs.push(quantise(v)); m.label.push(label); m.src.push(src); m.loc.push(loc);
  };
  const tPos = new Map(targets.map((t: any) => [t.id, t.pos as [number, number]]));

  // positives
  let seed = 1;
  for (const b of boxes) {
    const r = await cropPx(b.photo, b.box, 0.1, true);
    if (Math.min(r.width, r.height) < MIN_SOURCE_PX) { console.log(`skip ${b.id}@${b.photo}: ${r.width}x${r.height}px too small`); continue; }
    const img = await shrink(await extractPng(b.photo, r));
    const rnd = mulberry32(seed++ * 7919);
    const pos = tPos.get(b.id)!;
    for (let k = 0; k < PER_SOURCE; k++) {
      add(await embedFn(await augment(img, k === 0 ? null : rnd)), ids.indexOf(b.id), b.photo, [pos[0], pos[1], 1]);
    }
    process.stdout.write(`  ${b.id}@${b.photo} ✓\n`);
  }

  // landmark tiles (with locations) from the wide shots
  const bg = classes.length - 1;
  for (const photo of ['03', '01']) {
    const ts = await tiles(photo, [0.12, 0.2, 0.3]);
    for (const t of ts) {
      const l = photo === '03' ? fromPhoto03(t.cx, t.cy) : fromPhoto01(t.cx, t.cy);
      add(await embedFn(await toInput(await extractPng(photo, t.r))), bg, `tile-${photo}`, l.stair === 1 ? [l.x, l.y, 1] : [-1, -1, l.stair]);
    }
    console.log(`  tiles ${photo}: ${ts.length}`);
  }
  // hard negatives (no location) from the rest of each close-up
  for (const b of boxes.filter((x) => !WIDE.has(x.photo))) {
    const ts = await tiles(b.photo, [0.3, 0.45]);
    for (const t of ts) add(await embedFn(await toInput(await extractPng(b.photo, t.r))), bg, `tile-${b.photo}`, null);
    console.log(`  negatives ${b.photo}: ${ts.length}`);
  }

  m.count = vecs.length;
  const bin = new Int8Array(m.count * DIM);
  vecs.forEach((v, i) => bin.set(v, i * DIM));
  await writeFile(join(OUT, 'index.bin'), Buffer.from(bin.buffer));
  await writeFile(join(OUT, 'index.json'), JSON.stringify(m));
  console.log(`index: ${m.count} rows × ${DIM} → ${(bin.byteLength / 1024).toFixed(0)} KB (${m.model})`);
}

async function writePreview() {
  // build/preview/<id>.png: the identity view plus 7 augmented views, side by side
  const dir = join(ROOT, 'build/preview');
  await mkdir(dir, { recursive: true });
  for (const b of boxes.filter((x) => !WIDE.has(x.photo))) {
    const img = await shrink(await extractPng(b.photo, await cropPx(b.photo, b.box, 0.1, true)));
    const rnd = mulberry32(99);
    const views = [];
    for (let k = 0; k < 8; k++) views.push(await augment(img, k === 0 ? null : rnd));
    await sharp({ create: { width: INPUT * 8, height: INPUT, channels: 3, background: '#000' } })
      .composite(views.map((v, k) => ({ input: v, raw: { width: INPUT, height: INPUT, channels: 3 }, left: k * INPUT, top: 0 })))
      .png().toFile(join(dir, `${b.id}.png`));
  }
  console.log(`preview: ${dir}`);
}

await mkdir(OUT, { recursive: true });
await writeAssets();
if (args.has('--preview')) await writePreview();
else if (!ASSETS_ONLY) {
  let embedFn: Embedder;
  if (MOCK) {
    console.warn('MOCK embedder: the index will not recognise anything. Use for pipeline tests only.');
    embedFn = mockEmbedder();
  } else {
    console.log(`loading ${MODEL_ID} (${DTYPE})…`);
    await loadModel({ device: 'cpu', dtype: DTYPE, onProgress: (f) => process.stdout.write(`\r  model ${(f * 100).toFixed(0)}%   `) });
    console.log('');
    embedFn = (rgb) => embed(rgb, 3);
  }
  const t0 = Date.now();
  await buildIndex(embedFn);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s. Next: npm run self-test`);
}
