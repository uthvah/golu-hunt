// Shared by scripts/build-index.ts (Node) and src/worker.ts (browser).
// Both sides hand this module a 224x224 RGB(A) pixel buffer that they resized
// themselves, so the model always sees identically normalised input.
import { AutoModel, Tensor, env } from '@huggingface/transformers';
import type { PreTrainedModel } from '@huggingface/transformers';

import { MODEL_ID, INPUT, DIM } from './constants';
export { MODEL_ID, INPUT, DIM };
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type Device = 'wasm' | 'webgpu' | 'cpu';
export type DType = 'q8' | 'fp32' | 'fp16';

export interface LoadOptions {
  device: Device;
  dtype: DType;
  onProgress?: (fraction: number) => void;
}

let model: PreTrainedModel | null = null;

export async function loadModel(opts: LoadOptions): Promise<void> {
  env.allowLocalModels = false;
  model = await AutoModel.from_pretrained(MODEL_ID, {
    device: opts.device,
    dtype: opts.dtype,
    progress_callback: (p: { status: string; progress?: number }) => {
      if (p.status === 'progress_total' && typeof p.progress === 'number') {
        opts.onProgress?.(p.progress / 100);
      }
    },
  });
}

/** pixels: INPUT*INPUT pixels, `channels` bytes each (3 = RGB, 4 = RGBA). */
export function toPixelTensor(pixels: ArrayLike<number>, channels: 3 | 4): Tensor {
  const n = INPUT * INPUT;
  if (pixels.length !== n * channels) {
    throw new Error(`Expected ${n * channels} bytes, got ${pixels.length}`);
  }
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    data[i] = (pixels[o] / 255 - MEAN[0]) / STD[0];
    data[n + i] = (pixels[o + 1] / 255 - MEAN[1]) / STD[1];
    data[2 * n + i] = (pixels[o + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new Tensor('float32', data, [1, 3, INPUT, INPUT]);
}

export function l2normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const inv = 1 / Math.sqrt(s || 1);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

/** Returns the L2-normalised CLS embedding (DIM floats). */
export async function embed(pixels: ArrayLike<number>, channels: 3 | 4): Promise<Float32Array> {
  if (!model) throw new Error('Model not loaded');
  const out = (await model({ pixel_values: toPixelTensor(pixels, channels) })) as Record<string, Tensor>;
  // pooler_output = [1, DIM] (layer-normed CLS). last_hidden_state = [1, tokens, DIM];
  // its first DIM values are the same CLS token.
  const t = out.pooler_output ?? out.last_hidden_state;
  if (!t) throw new Error('Model returned no usable output');
  const v = Float32Array.from((t.data as Float32Array).subarray(0, DIM));
  return l2normalise(v);
}
