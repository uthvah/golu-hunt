// Dev-only box annotation tool (npm run dev → /annotate.html).
import boxesJson from '../data/boxes.json';
import targetsJson from '../data/targets.json';

type Box = [number, number, number, number];
interface Row { id: string; photo: string; box: Box }

const urls = import.meta.glob('../data/photos/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const photos = Object.keys(urls).map((k) => k.match(/(\d+)\.jpg$/)![1]).sort();
const ids = (targetsJson as { targets: { id: string }[] }).targets.map((t) => t.id);
const rows: Row[] = (boxesJson as unknown as { boxes: Row[] }).boxes.map((b) => ({ ...b, box: [...b.box] as Box }));

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const photoSel = $<HTMLSelectElement>('#photo'), dollSel = $<HTMLSelectElement>('#doll');
const cv = $<HTMLCanvasElement>('#cv'), ctx = cv.getContext('2d')!;
const list = $<HTMLUListElement>('#list'), out = $<HTMLTextAreaElement>('#out');
photoSel.innerHTML = photos.map((p) => `<option>${p}</option>`).join('');
dollSel.innerHTML = ids.map((i) => `<option>${i}</option>`).join('');

const img = new Image();
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

function json() {
  const sorted = [...rows].sort((a, b) => a.photo.localeCompare(b.photo) || ids.indexOf(a.id) - ids.indexOf(b.id));
  return JSON.stringify({ _note: 'Boxes are [x0, y0, x1, y1] as fractions of the photo.', boxes: sorted.map((r) => ({ ...r, box: r.box.map((v) => +v.toFixed(4)) })) }, null, 2);
}

function draw() {
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  ctx.lineWidth = 3;
  ctx.font = '600 16px system-ui';
  for (const r of rows.filter((r) => r.photo === photoSel.value)) {
    const [x0, y0, x1, y1] = r.box.map((v, i) => v * (i % 2 ? cv.height : cv.width));
    ctx.strokeStyle = r.id === dollSel.value ? '#5fb36f' : '#d9a93a';
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(r.id, x0 + 4, y0 + 18);
  }
  if (drag) { ctx.strokeStyle = '#fff'; ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); }
  list.innerHTML = rows.filter((r) => r.photo === photoSel.value).map((r) =>
    `<li class="${r.id === dollSel.value ? 'sel' : ''}"><span>${r.id}</span><button data-del="${r.id}">delete</button></li>`).join('') || '<li>No boxes on this photo yet.</li>';
  out.value = json();
}

function load() {
  img.onload = () => {
    const maxW = innerWidth - 320, maxH = innerHeight - 10;
    const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    cv.width = Math.round(img.naturalWidth * s);
    cv.height = Math.round(img.naturalHeight * s);
    draw();
  };
  img.src = urls[`../data/photos/${photoSel.value}.jpg`];
}

const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
cv.addEventListener('pointerdown', (e) => { const p = pos(e); drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (!drag) return; const p = pos(e); drag.x1 = p.x; drag.y1 = p.y; draw(); });
cv.addEventListener('pointerup', () => {
  if (!drag) return;
  const x0 = Math.min(drag.x0, drag.x1) / cv.width, x1 = Math.max(drag.x0, drag.x1) / cv.width;
  const y0 = Math.min(drag.y0, drag.y1) / cv.height, y1 = Math.max(drag.y0, drag.y1) / cv.height;
  drag = null;
  if (x1 - x0 > 0.005 && y1 - y0 > 0.005) {
    const i = rows.findIndex((r) => r.id === dollSel.value && r.photo === photoSel.value);
    const row: Row = { id: dollSel.value, photo: photoSel.value, box: [x0, y0, x1, y1] };
    if (i >= 0) rows[i] = row; else rows.push(row);
  }
  draw();
});
list.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).dataset.del;
  if (!id) return;
  const i = rows.findIndex((r) => r.id === id && r.photo === photoSel.value);
  if (i >= 0) rows.splice(i, 1);
  draw();
});
photoSel.addEventListener('change', load);
dollSel.addEventListener('change', draw);
$('#download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' }));
  a.download = 'boxes.json';
  a.click();
});
$('#copy').addEventListener('click', () => navigator.clipboard.writeText(json()));
photoSel.value = '03';
load();
