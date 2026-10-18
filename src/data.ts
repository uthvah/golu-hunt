import targetsJson from '../data/targets.json';
import storiesJson from '../data/stories.json';
import boxesJson from '../data/boxes.json';
import { stepLabel } from './locate';

export interface Target {
  id: string;
  title: string;
  step: number;
  pos: [number, number];
  riddle: string;
  story: string;
  lookCloser: string;
  /** Box in photo 03 (photo mode), [x0, y0, x1, y1] fractions. */
  box: [number, number, number, number];
}

const stories = storiesJson as unknown as Record<string, { riddle: string; story: string; lookCloser: string }>;
const boxes = (boxesJson as unknown as { boxes: { id: string; photo: string; box: [number, number, number, number] }[] }).boxes;

export const TARGETS: Target[] = (targetsJson as unknown as { targets: Omit<Target, 'riddle' | 'story' | 'lookCloser' | 'box'>[] }).targets.map((t) => {
  const s = stories[t.id];
  const b = boxes.find((x) => x.id === t.id && x.photo === '03');
  if (!s || !b) throw new Error(`Missing story or photo-03 box for ${t.id}`);
  return { ...t, ...s, box: b.box };
});

export const byId = (id: string) => TARGETS.find((t) => t.id === id)!;

export const placeHint = (t: Target) => `On the middle staircase, ${stepLabel(t.step)}.`;

export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;
