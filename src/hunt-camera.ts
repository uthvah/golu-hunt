import { grab } from './camera';
import { recognizer, decideOptions, type FrameResult } from './recognizer';
import { Stabiliser, type Loc } from './match';
import { hintText } from './locate';
import { byId, type Target } from './data';

export type Warmth = 0 | 1 | 2;

export interface CameraHuntEvents {
  found(id: string): void;
  warmth(w: Warmth, s: number): void;
  hint(text: string): void;
  frame?(r: FrameResult, fps: number): void;
}

const FRAME_INTERVAL = 150;
const HINT_INTERVAL = 1500;
const LANDMARK_EVERY = 3;

export interface LogRow { t: number; target: string; tag: string; top: string; vote: string; s1: number; s2: number; sTarget: number; votes: number; ms: number }

export class CameraHunt {
  private running = false;
  private stab = new Stabiliser(7, 5);
  private frameNo = 0;
  private lastHint = 0;
  private warm = 0;
  private times: number[] = [];
  liveHints = false;
  recording = false;
  tag = '';
  log: LogRow[] = [];

  constructor(private video: HTMLVideoElement, private target: Target, private ev: CameraHuntEvents) {}

  setTarget(t: Target) { this.target = t; this.stab.reset(); this.warm = 0; }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() { this.running = false; }

  private async loop() {
    while (this.running) {
      const t0 = performance.now();
      if (document.hidden || this.video.readyState < 2 || recognizer.status.stage !== 'ready') {
        await sleep(250);
        continue;
      }
      const landmark = this.liveHints && this.frameNo % LANDMARK_EVERY === 0;
      this.frameNo++;
      let r: FrameResult;
      try {
        const g = grab(this.video, landmark);
        r = await recognizer.process(g.crop, g.landmark);
      } catch {
        await sleep(300);
        continue;
      }
      if (!this.running) break;
      this.handle(r);
      const wait = FRAME_INTERVAL - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }

  private handle(r: FrameResult) {
    const now = performance.now();
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 3000) this.times.shift();
    const fps = this.times.length / 3;

    const classes = recognizer.status.classes!;
    const ti = classes.indexOf(this.target.id);
    const sTarget = r.best[ti];
    this.warm = this.warm * 0.6 + sTarget * 0.4;
    const w: Warmth = this.warm >= decideOptions.tau ? 2 : this.warm >= decideOptions.tau - 0.12 ? 1 : 0;
    this.ev.warmth(w, this.warm);
    this.ev.frame?.(r, fps);

    if (this.recording) {
      this.log.push({ t: Date.now(), target: this.target.id, tag: this.tag, top: r.top, vote: r.vote ?? '', s1: r.s1, s2: r.s2, sTarget, votes: r.votes, ms: r.ms });
    }

    const confirmed = this.stab.push(r.vote);
    if (confirmed === this.target.id) {
      this.running = false;
      this.ev.found(confirmed);
      return;
    }

    if (this.liveHints && now - this.lastHint > HINT_INTERVAL) {
      let cur: Loc | null = null;
      if (confirmed) {
        const p = byId(confirmed).pos;
        cur = { x: p[0], y: p[1], stair: 1 };
      } else if (r.loc) {
        cur = r.loc;
      }
      if (cur) {
        this.ev.hint(confirmed ? `That’s ${byId(confirmed).title}. ${hintText(cur, this.target.pos)}` : hintText(cur, this.target.pos));
        this.lastHint = now;
      }
    }
  }

  csv(): string {
    const head = 't,target,tag,top,vote,s1,s2,sTarget,votes,ms';
    const rows = this.log.map((l) => [new Date(l.t).toISOString(), l.target, JSON.stringify(l.tag), l.top, l.vote, l.s1.toFixed(4), l.s2.toFixed(4), l.sTarget.toFixed(4), l.votes, l.ms.toFixed(0)].join(','));
    return [head, ...rows].join('\n');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
