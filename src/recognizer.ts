// Main-thread client for the recognition worker.
import type { WorkerIn, WorkerOut, FrameResult } from './worker';
import { DEFAULT_DECIDE, type DecideOptions } from './match';
import type { Device, DType } from './embed';

export type { FrameResult };

export interface RecognizerStatus {
  stage: 'idle' | 'index' | 'model' | 'ready' | 'error';
  fraction: number;
  error?: { code: string; message: string };
  classes?: string[];
  info?: string;
}

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
export const DEBUG = params.has('debug');
export const decideOptions: DecideOptions = {
  tau: num('tau', DEFAULT_DECIDE.tau),
  margin: num('margin', DEFAULT_DECIDE.margin),
  minVotes: num('votes', DEFAULT_DECIDE.minVotes),
};
// Default: 8-bit model on WASM, the same weights the index was built with.
// ?gpu tries WebGPU with full-precision weights (faster on some phones, 88 MB download).
const useGpu = params.has('gpu') && 'gpu' in navigator;
const device: Device = useGpu ? 'webgpu' : 'wasm';
const dtype: DType = useGpu ? 'fp32' : 'q8';

class Recognizer {
  status: RecognizerStatus = { stage: 'idle', fraction: 0 };
  private worker: Worker | null = null;
  private listeners = new Set<(s: RecognizerStatus) => void>();
  private pending = new Map<number, { resolve: (r: FrameResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  onStatus(fn: (s: RecognizerStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private set(s: Partial<RecognizerStatus>) {
    this.status = { ...this.status, ...s };
    for (const fn of this.listeners) fn(this.status);
  }

  /** Starts loading the index and model in the background. Safe to call twice. */
  load(): void {
    if (this.worker) return;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerOut>) => this.handle(ev.data);
    this.worker.onerror = (ev) => this.set({ stage: 'error', error: { code: 'model', message: ev.message || 'Worker failed to start' } });
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    this.post({ type: 'init', base, device, dtype, decide: decideOptions });
    this.set({ stage: 'index', fraction: 0 });
  }

  private post(m: WorkerIn, transfer: Transferable[] = []) { this.worker!.postMessage(m, transfer); }

  private handle(m: WorkerOut) {
    switch (m.type) {
      case 'progress':
        this.set({ stage: m.stage, fraction: m.fraction });
        break;
      case 'ready':
        this.set({ stage: 'ready', fraction: 1, classes: m.classes, info: `${m.rows} refs · ${m.device} · τ ${m.decide.tau} m ${m.decide.margin}` });
        break;
      case 'error':
        if (m.code === 'frame' && m.id !== undefined) {
          this.pending.get(m.id)?.reject(new Error(m.message));
          this.pending.delete(m.id);
        } else {
          this.set({ stage: 'error', error: { code: m.code, message: m.message } });
        }
        break;
      case 'result':
        this.pending.get(m.id)?.resolve(m);
        this.pending.delete(m.id);
        break;
    }
  }

  process(crop: ImageData, landmark?: ImageData): Promise<FrameResult> {
    if (this.status.stage !== 'ready') return Promise.reject(new Error('Recognizer not ready'));
    const id = this.nextId++;
    const transfer: Transferable[] = [crop.data.buffer];
    if (landmark) transfer.push(landmark.data.buffer);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'frame', id, crop: crop.data, landmark: landmark?.data }, transfer);
    });
  }
}

export const recognizer = new Recognizer();
