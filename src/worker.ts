/// <reference lib="webworker" />
import { loadModel, embed, type Device, type DType } from './embed';
import { decodeIndex, score, decide, DEFAULT_DECIDE, type DecideOptions, type IndexMeta, type Loc, type RefIndex } from './match';
import { estimateFromNeighbours } from './locate';

export type WorkerIn =
  | { type: 'init'; base: string; device: Device; dtype: DType; decide?: Partial<DecideOptions> }
  | { type: 'frame'; id: number; crop: Uint8ClampedArray; landmark?: Uint8ClampedArray };

export interface FrameResult {
  type: 'result';
  id: number;
  vote: string | null; // doll this frame votes for
  top: string;         // best class, incl. 'bg'
  s1: number;
  s2: number;
  votes: number;
  best: number[];      // per class, aligned with `classes`
  loc: Loc | null;     // from the landmark crop, when one was sent
  ms: number;
}

export type WorkerOut =
  | { type: 'progress'; stage: 'index' | 'model'; fraction: number }
  | { type: 'ready'; classes: string[]; rows: number; model: string; device: Device; decide: DecideOptions }
  | { type: 'error'; code: 'index' | 'model' | 'frame'; message: string; id?: number }
  | FrameResult;

const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let index: RefIndex | null = null;
let opts: DecideOptions = DEFAULT_DECIDE;

async function init(m: Extract<WorkerIn, { type: 'init' }>) {
  opts = { ...DEFAULT_DECIDE, ...m.decide };
  let meta: IndexMeta;
  try {
    post({ type: 'progress', stage: 'index', fraction: 0 });
    const [j, b] = await Promise.all([fetch(new URL('index.json', m.base)), fetch(new URL('index.bin', m.base))]);
    if (!j.ok || !b.ok) throw new Error(`index files not found (HTTP ${j.status}/${b.status})`);
    try { meta = await j.json(); } catch { throw new Error('index.json is missing or not valid JSON (run npm run build-index)'); }
    index = decodeIndex(meta, await b.arrayBuffer());
    if (meta.model === 'mock') throw new Error('index.bin was built with --mock and can’t recognise dolls');
    post({ type: 'progress', stage: 'index', fraction: 1 });
  } catch (e) {
    post({ type: 'error', code: 'index', message: String((e as Error).message ?? e) });
    return;
  }
  try {
    await loadModel({ device: m.device, dtype: m.dtype, onProgress: (f) => post({ type: 'progress', stage: 'model', fraction: f }) });
  } catch (e) {
    post({ type: 'error', code: 'model', message: String((e as Error).message ?? e) });
    return;
  }
  post({ type: 'ready', classes: index.classes, rows: index.count, model: meta.model, device: m.device, decide: opts });
}

async function frame(m: Extract<WorkerIn, { type: 'frame' }>) {
  if (!index) return;
  const t0 = performance.now();
  try {
    const q = await embed(m.crop, 4);
    const sc = score(index, q, 7);
    let loc: Loc | null = null;
    if (m.landmark) {
      const ql = await embed(m.landmark, 4);
      loc = estimateFromNeighbours(index, score(index, ql, 7).neighbours);
    }
    post({
      type: 'result',
      id: m.id,
      vote: decide(index, sc, opts),
      top: index.classes[sc.top],
      s1: sc.s1,
      s2: sc.s2,
      votes: sc.votes,
      best: Array.from(sc.best),
      loc,
      ms: performance.now() - t0,
    });
  } catch (e) {
    post({ type: 'error', code: 'frame', message: String((e as Error).message ?? e), id: m.id });
  }
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  if (m.type === 'init') void init(m);
  else if (m.type === 'frame') void frame(m);
};
