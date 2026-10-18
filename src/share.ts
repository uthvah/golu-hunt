import { TARGETS, asset } from './data';
import { isFound, foundCount, score, maxScore, elapsedText } from './game';

const C = { ground: '#0F4A55', deep: '#0A3138', zari: '#D9A93A', rice: '#F7F2E6', muted: '#A9C3C1' };

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = rej;
  i.src = src;
});

function templeBorder(ctx: CanvasRenderingContext2D, y: number, w: number, up: boolean) {
  // A row of small temple-tower triangles, like a silk sari border.
  ctx.fillStyle = C.zari;
  ctx.fillRect(0, up ? y : y - 6, w, 6);
  const step = 36, th = 22;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath();
    if (up) { ctx.moveTo(x + 4, y + 6); ctx.lineTo(x + step / 2, y + 6 + th); ctx.lineTo(x + step - 4, y + 6); }
    else { ctx.moveTo(x + 4, y - 6); ctx.lineTo(x + step / 2, y - 6 - th); ctx.lineTo(x + step - 4, y - 6); }
    ctx.closePath();
    ctx.fill();
  }
}

export async function resultImage(): Promise<Blob> {
  await document.fonts.ready;
  const W = 1080, H = 1350;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);
  templeBorder(ctx, 0, W, true);
  templeBorder(ctx, H, W, false);

  ctx.fillStyle = C.rice;
  ctx.font = '96px "Rozha One", Georgia, serif';
  ctx.fillText('Golu Hunt', 72, 170);
  ctx.font = '40px Mukta, system-ui, sans-serif';
  ctx.fillStyle = C.zari;
  ctx.fillText(`${foundCount()} of ${TARGETS.length} dolls found, ${score()} of ${maxScore()} points`, 72, 236);
  const t = elapsedText();
  if (t) { ctx.fillStyle = C.muted; ctx.fillText(t[0].toUpperCase() + t.slice(1), 72, 290); }

  const cell = 300, gap = 18, x0 = (W - (cell * 3 + gap * 2)) / 2, y0 = 360;
  for (let i = 0; i < TARGETS.length; i++) {
    const x = x0 + (i % 3) * (cell + gap), y = y0 + Math.floor(i / 3) * (cell + gap);
    ctx.fillStyle = C.deep;
    ctx.fillRect(x, y, cell, cell);
    if (isFound(TARGETS[i].id)) {
      try {
        const img = await loadImg(asset(`crops/${TARGETS[i].id}.jpg`));
        const s = Math.max(cell / img.width, cell / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, cell, cell); ctx.clip();
        ctx.drawImage(img, x + (cell - w) / 2, y + (cell - h) / 2, w, h);
        ctx.restore();
      } catch { /* leave the tile plain */ }
    } else {
      ctx.fillStyle = C.muted;
      ctx.font = '120px "Rozha One", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', x + cell / 2, y + cell / 2 + 42);
      ctx.textAlign = 'left';
    }
    ctx.strokeStyle = C.zari;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
  }
  return new Promise((res) => cv.toBlob((b) => res(b!), 'image/png'));
}

export async function shareResult(): Promise<'shared' | 'downloaded'> {
  const blob = await resultImage();
  const file = new File([blob], 'golu-hunt.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Golu Hunt' });
      return 'shared';
    } catch { /* cancelled: fall through to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'golu-hunt.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
