// Pan / pinch-zoom / tap viewer for the middle-staircase photo.
export interface TapEvent { fx: number; fy: number; clientX: number; clientY: number }

export class PhotoViewer {
  private img: HTMLImageElement;
  private s = 1; private tx = 0; private ty = 0; private fit = 1;
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean } | null = null;
  private pinch: { d: number; s: number; cx: number; cy: number; tx: number; ty: number } | null = null;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, src: string, private onTap: (e: TapEvent) => void) {
    this.img = document.createElement('img');
    this.img.src = src;
    this.img.alt = 'The middle staircase of the golu';
    this.img.draggable = false;
    this.img.className = 'photo-img';
    host.append(this.img);
    this.img.addEventListener('load', () => this.reset());
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onUp);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    this.ro = new ResizeObserver(() => this.reset());
    this.ro.observe(host);
  }

  destroy() { this.ro.disconnect(); this.host.replaceChildren(); }

  reset() {
    const w = this.img.naturalWidth, h = this.img.naturalHeight;
    if (!w) return;
    const W = this.host.clientWidth, H = this.host.clientHeight;
    this.fit = Math.min(W / w, H / h);
    // Start zoomed in on the steps so the dolls are big enough to tap.
    this.s = this.fit * 1.8;
    this.tx = W / 2 - 0.5 * w * this.s;
    this.ty = H / 2 - 0.45 * h * this.s;
    this.apply();
  }

  /** Screen position (relative to host) of a point given as image fractions. */
  toScreen(fx: number, fy: number) {
    return { x: this.tx + fx * this.img.naturalWidth * this.s, y: this.ty + fy * this.img.naturalHeight * this.s };
  }

  private clamp() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const w = this.img.naturalWidth * this.s, h = this.img.naturalHeight * this.s;
    this.tx = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, this.tx));
    this.ty = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, this.ty));
  }

  private apply() {
    this.clamp();
    this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
  }

  private zoomAt(cx: number, cy: number, s: number) {
    s = Math.min(this.fit * 8, Math.max(this.fit, s));
    this.tx = cx - ((cx - this.tx) * s) / this.s;
    this.ty = cy - ((cy - this.ty) * s) / this.s;
    this.s = s;
    this.apply();
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    this.host.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) this.down = { ...p, t: performance.now(), moved: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: this.tx, ty: this.ty };
      if (this.down) this.down.moved = true;
    }
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const s = Math.min(this.fit * 8, Math.max(this.fit, (this.pinch.s * d) / this.pinch.d));
      this.tx = cx - ((this.pinch.cx - this.pinch.tx) * s) / this.pinch.s;
      this.ty = cy - ((this.pinch.cy - this.pinch.ty) * s) / this.pinch.s;
      this.s = s;
      this.apply();
      return;
    }
    if (this.pointers.size === 1) {
      this.tx += p.x - prev.x;
      this.ty += p.y - prev.y;
      if (this.down && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 8) this.down.moved = true;
      this.apply();
    }
  };

  private onUp = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0 && this.down && !this.down.moved && performance.now() - this.down.t < 500) {
      const fx = (p.x - this.tx) / (this.img.naturalWidth * this.s);
      const fy = (p.y - this.ty) / (this.img.naturalHeight * this.s);
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) this.onTap({ fx, fy, clientX: e.clientX, clientY: e.clientY });
    }
    if (this.pointers.size === 0) this.down = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, this.s * Math.exp(-e.deltaY * 0.0015));
  };

  zoomBy(f: number) { this.zoomAt(this.host.clientWidth / 2, this.host.clientHeight / 2, this.s * f); }
}

/** Box hit test with a little forgiveness for fingers. */
export function inBox(fx: number, fy: number, b: [number, number, number, number], slack = 0.12): boolean {
  const w = b[2] - b[0], h = b[3] - b[1];
  return fx >= b[0] - w * slack && fx <= b[2] + w * slack && fy >= b[1] - h * slack && fy <= b[3] + h * slack;
}
