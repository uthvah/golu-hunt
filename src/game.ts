import { TARGETS } from './data';

const KEY = 'golu-hunt-v1';
export const POINTS_BY_TIER = [0, 3, 2, 1]; // tier 1 = riddle only

export interface Progress {
  found: Record<string, { points: number; at: number }>;
  tier: Record<string, number>; // highest hint tier revealed per target (1..3)
  startedAt: number | null;
  finishedAt: number | null;
}

const empty = (): Progress => ({ found: {}, tier: {}, startedAt: null, finishedAt: null });

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const p = JSON.parse(raw) as Progress;
    return { ...empty(), ...p };
  } catch {
    return empty();
  }
}

export const progress: Progress = load();

export function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch { /* private mode: progress lives for this tab only */ }
}

export function start(): void {
  if (!progress.startedAt) { progress.startedAt = Date.now(); save(); }
}

export const tierOf = (id: string) => progress.tier[id] ?? 1;

export function revealNextTier(id: string): number {
  const t = Math.min(3, tierOf(id) + 1);
  progress.tier[id] = t;
  save();
  return t;
}

export const isFound = (id: string) => Boolean(progress.found[id]);
export const foundCount = () => TARGETS.filter((t) => isFound(t.id)).length;
export const score = () => Object.values(progress.found).reduce((a, f) => a + f.points, 0);
export const maxScore = () => TARGETS.length * POINTS_BY_TIER[1];

/** Records a find; returns the points earned (0 if already found). */
export function markFound(id: string): number {
  if (isFound(id)) return 0;
  const points = POINTS_BY_TIER[tierOf(id)];
  progress.found[id] = { points, at: Date.now() };
  if (foundCount() === TARGETS.length && !progress.finishedAt) progress.finishedAt = Date.now();
  save();
  return points;
}

export function finish(): void {
  if (!progress.finishedAt) { progress.finishedAt = Date.now(); save(); }
}

export function reset(): void {
  Object.assign(progress, empty());
  save();
}

export function elapsedText(): string {
  if (!progress.startedAt) return '';
  const ms = (progress.finishedAt ?? Date.now()) - progress.startedAt;
  const min = Math.round(ms / 60000);
  if (min < 1) return 'in under a minute';
  if (min < 90) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.floor(min / 60);
  return `in ${h} h ${min % 60} min`;
}

export const nextUnfound = (after?: string) => {
  const i = after ? TARGETS.findIndex((t) => t.id === after) : -1;
  for (let k = 1; k <= TARGETS.length; k++) {
    const t = TARGETS[(i + k) % TARGETS.length];
    if (!isFound(t.id)) return t;
  }
  return null;
};
