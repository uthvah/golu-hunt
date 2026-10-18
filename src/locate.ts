// Where is the player pointing, and what should the hint say?
// Coordinates are fractions of photo 03 (the middle staircase).
import type { Loc, Neighbour, RefIndex } from './match';
import layoutJson from '../data/layout.json';

export interface Layout {
  stepEdges: number[];
  staircaseWidth: number;
  photo03Middle: [number, number];
  photo01: { left: [number, number]; middle: [number, number]; right: [number, number] };
  photo01ToMiddle: { ax: number; bx: number; ay: number; by: number };
}
export const layout = layoutJson as unknown as Layout;

/** 0 = top ledge, 1..4 = steps from the top, 5 = floor. */
export function stepOf(y: number, edges = layout.stepEdges): number {
  let s = 0;
  while (s < edges.length && y >= edges[s]) s++;
  return s;
}

export function stepLabel(step: number): string {
  if (step <= 0) return 'the top ledge';
  if (step >= layout.stepEdges.length) return 'the floor in front';
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
  return `the ${words[step] ?? `${step}th`} step from the top`;
}

/** Location from landmark neighbours; null when they disagree. */
export function estimateFromNeighbours(index: RefIndex, nn: Neighbour[]): Loc | null {
  const pts = nn.map((n) => ({ l: index.loc[n.i], w: Math.max(0.01, n.s) })).filter((p) => p.l) as { l: Loc; w: number }[];
  if (pts.length < 3) return null;
  const stairVotes = [0, 0, 0];
  for (const p of pts) stairVotes[p.l.stair] += p.w;
  const stair = stairVotes.indexOf(Math.max(...stairVotes)) as Loc['stair'];
  const same = pts.filter((p) => p.l.stair === stair);
  if (same.length < 3) return null;
  if (stair !== 1) return { x: NaN, y: NaN, stair };
  let wx = 0, wy = 0, w = 0;
  for (const p of same) { wx += p.l.x * p.w; wy += p.l.y * p.w; w += p.w; }
  const x = wx / w, y = wy / w;
  const colSpread = Math.max(...same.map((p) => Math.abs(p.l.x - x))) / layout.staircaseWidth;
  const steps = same.map((p) => stepOf(p.l.y));
  const stepSpread = Math.max(...steps) - Math.min(...steps);
  if (colSpread > 0.15 || stepSpread > 1) return null;
  return { x, y, stair };
}

/** Plain-language direction from where the player points to the target. */
export function hintText(cur: Loc, target: [number, number]): string {
  if (cur.stair === 0) return 'That’s the left staircase. Move right to the middle one.';
  if (cur.stair === 2) return 'That’s the right staircase. Move left to the middle one.';
  const dStep = stepOf(target[1]) - stepOf(cur.y);
  const dCol = (target[0] - cur.x) / layout.staircaseWidth;
  const a = Math.abs(dCol);
  if (dStep === 0 && a < 0.1) return 'It’s right here. Get closer.';
  const parts: string[] = [];
  if (dStep !== 0) {
    const n = Math.abs(dStep);
    const count = n === 1 ? 'One step' : `${['', '', 'Two', 'Three', 'Four', 'Five'][n] ?? n} steps`;
    parts.push(`${count} ${dStep > 0 ? 'down' : 'up'}`);
  }
  if (a >= 0.1) {
    const side = dCol > 0 ? 'right' : 'left';
    const amount = a < 0.2 ? 'a little to the' : a > 0.5 ? 'far to the' : 'to the';
    parts.push(parts.length ? `${amount} ${side}` : `${amount[0].toUpperCase()}${amount.slice(1)} ${side}`);
  } else if (parts.length) {
    parts.push('in line with where you are');
  }
  return `${parts.join(', ')}.`;
}

/** Map a point in photo 01 (full shot) into the photo-03 frame. */
export function fromPhoto01(x1: number, y1: number): Loc {
  const p = layout.photo01;
  if (x1 < p.left[1]) return { x: NaN, y: NaN, stair: 0 };
  if (x1 >= p.right[0]) return { x: NaN, y: NaN, stair: 2 };
  const m = layout.photo01ToMiddle;
  return { x: m.ax * x1 + m.bx, y: m.ay * y1 + m.by, stair: 1 };
}

/** A point in photo 03; its edges show bits of the side staircases. */
export function fromPhoto03(x: number, y: number): Loc {
  const [lo, hi] = layout.photo03Middle;
  if (x < lo) return { x: NaN, y: NaN, stair: 0 };
  if (x > hi) return { x: NaN, y: NaN, stair: 2 };
  return { x, y, stair: 1 };
}
