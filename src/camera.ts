import { INPUT } from './constants';

export class CameraError extends Error {
  constructor(public kind: 'denied' | 'missing' | 'insecure' | 'other', message: string) { super(message); }
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) throw new CameraError('insecure', 'The camera only works over HTTPS.');
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('missing', 'This browser can’t use the camera.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', 'Camera access is blocked.');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('missing', 'No camera found.');
    throw new CameraError('other', String((e as Error).message ?? e));
  }
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  return stream;
}

export function closeCamera(video: HTMLVideoElement): void {
  const s = video.srcObject as MediaStream | null;
  s?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/** Fraction of the screen's short side covered by the on-screen reticle. */
export const RETICLE_FRACTION = 0.62;
/** The landmark crop is this much wider than the reticle (70% vs 45% in the blueprint). */
export const LANDMARK_RATIO = 70 / 45;

/** Reticle side in CSS px for the element showing the video. */
export function reticleSide(el: HTMLElement): number {
  return RETICLE_FRACTION * Math.min(el.clientWidth, el.clientHeight);
}

const canvas = document.createElement('canvas');
canvas.width = canvas.height = INPUT;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';

/**
 * Grabs the square under the reticle (and optionally the wider landmark square)
 * as 224x224 RGBA. Accounts for object-fit: cover on the video element.
 */
export function grab(video: HTMLVideoElement, withLandmark: boolean): { crop: ImageData; landmark?: ImageData } {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = video.clientWidth, ch = video.clientHeight;
  const scale = Math.max(cw / vw, ch / vh); // cover
  const side = Math.min(reticleSide(video) / scale, vw, vh);
  const square = (s: number) => {
    const ss = Math.min(s, vw, vh);
    ctx.drawImage(video, (vw - ss) / 2, (vh - ss) / 2, ss, ss, 0, 0, INPUT, INPUT);
    return ctx.getImageData(0, 0, INPUT, INPUT);
  };
  const crop = square(side);
  return withLandmark ? { crop, landmark: square(side * LANDMARK_RATIO) } : { crop };
}
