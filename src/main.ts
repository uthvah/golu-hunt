import './styles.css';
import { TARGETS, byId, placeHint, asset, type Target } from './data';
import * as game from './game';
import { recognizer, DEBUG, type RecognizerStatus } from './recognizer';
import { openCamera, closeCamera, reticleSide, CameraError } from './camera';
import { CameraHunt, type Warmth } from './hunt-camera';
import { PhotoViewer, inBox } from './photo-mode';
import { fromPhoto03, hintText } from './locate';
import { shareResult } from './share';

type Mode = 'camera' | 'photo';
const app = document.getElementById('app')!;
let mode: Mode = (sessionStorage.getItem('golu-mode') as Mode) || 'camera';
let cleanup: (() => void) | null = null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function mount(html: string): HTMLElement {
  cleanup?.();
  cleanup = null;
  app.innerHTML = html;
  const el = app.firstElementChild as HTMLElement;
  el.querySelector<HTMLElement>('[data-focus]')?.focus();
  window.scrollTo(0, 0);
  return el;
}
const border = '<div class="zari" aria-hidden="true"></div>';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- start
function startScreen() {
  const n = game.foundCount();
  const el = mount(`
    <main class="screen start">
      <div class="hero" style="background-image:url('${asset('golu-middle.jpg')}')" role="img" aria-label="The middle staircase of the golu"></div>
      ${border}
      <div class="start-body">
        <h1 class="title">Golu Hunt</h1>
        <p class="lede">Nine dolls on the golu each tell a story. Read a riddle, find the doll it describes, and point your camera at it to unlock the story.</p>
        <div class="actions">
          <button class="btn primary" data-act="camera">${n ? 'Keep hunting with the camera' : 'Hunt with the camera'}</button>
          <button class="btn" data-act="photo">Play on the photo</button>
        </div>
        <p class="note">The camera mode downloads about 30&nbsp;MB the first time it opens, so use the Wi-Fi.</p>
        ${n ? `<p class="note">You’ve found ${n} of ${TARGETS.length}. <button class="link" data-act="reset">Start over</button></p>` : ''}
      </div>
    </main>`);
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'camera' || act === 'photo') {
      mode = act;
      sessionStorage.setItem('golu-mode', mode);
      if (mode === 'camera') recognizer.load();
      game.start();
      listScreen();
    } else if (act === 'reset') {
      if (confirm('Clear your finds and start again?')) { game.reset(); startScreen(); }
    }
  });
}

// ---------------------------------------------------------------- list
function listScreen() {
  const found = game.foundCount();
  const done = found === TARGETS.length;
  const items = TARGETS.map((t, i) => {
    const f = game.progress.found[t.id];
    return `<li><button class="row ${f ? 'is-found' : ''}" data-id="${t.id}">
        <span class="thumb">${f ? `<img src="${asset(`crops/${t.id}.jpg`)}" alt="" loading="lazy">` : `<span class="num">${i + 1}</span>`}</span>
        <span class="row-text">
          ${f ? `<span class="row-title">${esc(t.title)}</span><span class="row-sub">${f.points} point${f.points === 1 ? '' : 's'}</span>` : `<span class="row-riddle">${esc(t.riddle)}</span>`}
        </span>
      </button></li>`;
  }).join('');
  const el = mount(`
    <main class="screen list">
      ${border}
      <header class="list-head">
        <button class="btn quiet small" data-act="home">Menu</button>
        <div>
          <h2>Nine to find</h2>
          <p class="tally">${found} found, ${game.score()} point${game.score() === 1 ? '' : 's'}. ${mode === 'camera' ? 'Camera mode.' : 'Photo mode.'} <button class="link" data-act="switch">Switch to ${mode === 'camera' ? 'the photo' : 'the camera'}</button></p>
        </div>
      </header>
      <ol class="rows">${items}</ol>
      <footer class="list-foot">
        <button class="btn ${done ? 'primary' : ''}" data-act="finish">${done ? 'See your result' : 'I’m done for now'}</button>
      </footer>
    </main>`);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>('[data-id]')?.dataset.id;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (id) game.isFound(id) ? foundSheet(byId(id), 0, true) : huntScreen(byId(id));
    else if (act === 'home') startScreen();
    else if (act === 'finish') finishedScreen();
    else if (act === 'switch') {
      mode = mode === 'camera' ? 'photo' : 'camera';
      sessionStorage.setItem('golu-mode', mode);
      if (mode === 'camera') recognizer.load();
      listScreen();
    }
  });
}

// ---------------------------------------------------------------- hunt (shared chrome)
function hintButtonLabel(tier: number) {
  return tier === 1 ? 'Show where to look' : tier === 2 ? (mode === 'camera' ? 'Turn on live directions' : 'Turn on directions') : '';
}

function huntScreen(t: Target) {
  const tier = game.tierOf(t.id);
  const el = mount(`
    <section class="hunt ${mode}" aria-label="Find: ${esc(t.title)}">
      <div class="stage"></div>
      <div class="hunt-top">
        <button class="btn quiet small" data-act="back">Back to the list</button>
        <p class="riddle">${esc(t.riddle)}</p>
      </div>
      <div class="hunt-bottom">
        <p class="hint" aria-live="polite"></p>
        <div class="hint-row">
          <button class="btn small" data-act="hint" ${tier >= 3 ? 'hidden' : ''}>${hintButtonLabel(tier)}</button>
          <span class="cost">${tier >= 3 ? 'Worth 1 point now.' : `Worth ${game.POINTS_BY_TIER[tier]} points. Each hint costs one.`}</span>
        </div>
      </div>
    </section>`);
  const stage = el.querySelector<HTMLElement>('.stage')!;
  const hintEl = el.querySelector<HTMLElement>('.hint')!;
  const hintBtn = el.querySelector<HTMLButtonElement>('[data-act="hint"]')!;
  const cost = el.querySelector<HTMLElement>('.cost')!;

  const showTier = (n: number) => {
    if (n >= 2) hintEl.textContent = placeHint(t);
    if (n >= 3) {
      hintEl.textContent = `${placeHint(t)} ${mode === 'camera' ? 'Point at any doll and you’ll be told which way to go.' : 'Tap anywhere and you’ll be told which way to go.'}`;
      hintBtn.hidden = true;
    } else {
      hintBtn.textContent = hintButtonLabel(n);
    }
    cost.textContent = n >= 3 ? 'Worth 1 point now.' : `Worth ${game.POINTS_BY_TIER[n]} points. Each hint costs one.`;
  };
  showTier(tier);

  const controller = mode === 'camera' ? cameraStage(stage, t, hintEl) : photoStage(stage, t, hintEl);
  hintBtn.addEventListener('click', () => {
    const n = game.revealNextTier(t.id);
    showTier(n);
    controller.tierChanged(n);
  });
  el.querySelector('[data-act="back"]')!.addEventListener('click', () => listScreen());
  cleanup = () => controller.stop();
}

interface StageController { stop(): void; tierChanged(n: number): void }

function onFound(t: Target) {
  const pts = game.markFound(t.id);
  if (!reduceMotion) navigator.vibrate?.([60, 40, 120]);
  foundSheet(t, pts, false);
}

// ---------------------------------------------------------------- camera stage
function cameraStage(stage: HTMLElement, t: Target, hintEl: HTMLElement): StageController {
  stage.innerHTML = `
    <video playsinline muted></video>
    <div class="reticle" data-warm="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="overlay-msg" role="status"></div>
    ${DEBUG ? '<div class="debug"></div>' : ''}`;
  const video = stage.querySelector('video')!;
  const reticle = stage.querySelector<HTMLElement>('.reticle')!;
  const msg = stage.querySelector<HTMLElement>('.overlay-msg')!;
  const dbg = stage.querySelector<HTMLElement>('.debug');
  let stopped = false;

  const sizeReticle = () => { reticle.style.setProperty('--side', `${reticleSide(video)}px`); };
  const ro = new ResizeObserver(sizeReticle);
  ro.observe(video);

  const hunt = new CameraHunt(video, t, {
    found: (id) => { closeCamera(video); onFound(byId(id)); },
    warmth: (w: Warmth) => { reticle.dataset.warm = String(w); },
    hint: (text) => { hintEl.textContent = text; },
    frame: dbg ? (r, fps) => {
      dbg.querySelector('.dbg-live')!.textContent =
        `top ${r.top}  vote ${r.vote ?? '-'}\ns1 ${r.s1.toFixed(3)}  s2 ${r.s2.toFixed(3)}  votes ${r.votes}/7\n${r.ms.toFixed(0)} ms  ${fps.toFixed(1)} fps  logged ${hunt.log.length}`;
    } : undefined,
  });
  hunt.liveHints = game.tierOf(t.id) >= 3;

  if (dbg) {
    dbg.innerHTML = `<pre class="dbg-live">waiting…</pre><pre class="dbg-info"></pre>
      <label>Tag <input class="dbg-tag" placeholder="e.g. 1m lights-on"></label>
      <button class="btn small" data-dbg="rec">Record</button>
      <button class="btn small" data-dbg="csv">Download CSV</button>`;
    dbg.querySelector<HTMLInputElement>('.dbg-tag')!.addEventListener('input', (e) => { hunt.tag = (e.target as HTMLInputElement).value; });
    dbg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dbg]');
      if (b?.dataset.dbg === 'rec') { hunt.recording = !hunt.recording; b.textContent = hunt.recording ? 'Stop' : 'Record'; }
      if (b?.dataset.dbg === 'csv') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([hunt.csv()], { type: 'text/csv' }));
        a.download = `golu-calibration-${Date.now()}.csv`;
        a.click();
      }
    });
  }

  const showError = (html: string) => {
    msg.innerHTML = `<div class="msg-card">${html}<div class="actions"><button class="btn primary small" data-act="to-photo">Play on the photo</button></div></div>`;
    msg.querySelector('[data-act="to-photo"]')!.addEventListener('click', () => {
      mode = 'photo';
      sessionStorage.setItem('golu-mode', mode);
      huntScreen(t);
    });
  };

  const onStatus = (s: RecognizerStatus) => {
    if (stopped) return;
    if (dbg) dbg.querySelector('.dbg-info')!.textContent = `${s.stage} ${s.info ?? ''}`;
    if (s.stage === 'error') {
      showError(s.error?.code === 'index'
        ? `<p>The doll index hasn’t been built for this site yet, so the camera can’t recognise anything.</p><p class="detail">${esc(s.error.message)}</p>`
        : `<p>The recognition model didn’t load. Check the connection and reload the page.</p><p class="detail">${esc(s.error?.message ?? '')}</p>`);
    } else if (s.stage === 'ready') {
      msg.innerHTML = '';
    } else {
      const pct = Math.round(s.fraction * 100);
      msg.innerHTML = `<div class="msg-card"><p>${s.stage === 'model' ? `Downloading the doll recogniser, ${pct}%` : 'Getting ready'}</p><div class="bar"><span style="width:${pct}%"></span></div></div>`;
    }
  };
  recognizer.load();
  const unsub = recognizer.onStatus(onStatus);

  openCamera(video).then(() => {
    if (stopped) { closeCamera(video); return; }
    sizeReticle();
    hunt.start();
  }).catch((e: unknown) => {
    const k = e instanceof CameraError ? e.kind : 'other';
    showError(k === 'denied'
      ? '<p>Camera access is blocked. Allow it in your browser’s site settings and reload, or play on the photo.</p>'
      : k === 'insecure'
        ? '<p>The camera needs a secure (https) address.</p>'
        : `<p>The camera didn’t start: ${esc((e as Error).message)}</p>`);
  });

  return {
    stop: () => { stopped = true; hunt.stop(); unsub(); ro.disconnect(); closeCamera(video); },
    tierChanged: (n) => { hunt.liveHints = n >= 3; },
  };
}

// ---------------------------------------------------------------- photo stage
function photoStage(stage: HTMLElement, t: Target, hintEl: HTMLElement): StageController {
  stage.innerHTML = `<div class="photo-host" aria-label="Pinch or scroll to zoom, drag to look around, tap a doll to choose it"></div>
    <div class="tap-mark" hidden></div>
    <div class="zoom"><button class="btn small" data-z="in" aria-label="Zoom in">+</button><button class="btn small" data-z="out" aria-label="Zoom out">−</button></div>`;
  const host = stage.querySelector<HTMLElement>('.photo-host')!;
  const mark = stage.querySelector<HTMLElement>('.tap-mark')!;
  let tier = game.tierOf(t.id);
  let timer = 0;
  const viewer = new PhotoViewer(host, asset('golu-middle.jpg'), ({ fx, fy }) => {
    const p = viewer.toScreen(fx, fy);
    mark.style.transform = `translate(${p.x}px, ${p.y}px)`;
    mark.hidden = false;
    mark.classList.remove('pulse'); void mark.offsetWidth; mark.classList.add('pulse');
    if (inBox(fx, fy, t.box)) { onFound(t); return; }
    const hit = TARGETS.find((o) => o.id !== t.id && inBox(fx, fy, o.box, 0));
    let text = hit ? `That’s ${hit.title}, a different story.` : 'Not this one.';
    if (tier >= 3) text += ` ${hintText(fromPhoto03(fx, fy), t.pos)}`;
    hintEl.textContent = text;
    clearTimeout(timer);
    timer = window.setTimeout(() => { mark.hidden = true; }, 1600);
  });
  stage.querySelector('.zoom')!.addEventListener('click', (e) => {
    const z = (e.target as HTMLElement).closest<HTMLElement>('[data-z]')?.dataset.z;
    if (z) viewer.zoomBy(z === 'in' ? 1.5 : 1 / 1.5);
  });
  return { stop: () => { clearTimeout(timer); viewer.destroy(); }, tierChanged: (n) => { tier = n; } };
}

// ---------------------------------------------------------------- found
function foundSheet(t: Target, points: number, revisit: boolean) {
  const next = game.nextUnfound(t.id);
  const el = mount(`
    <section class="screen found" aria-labelledby="found-title">
      ${border}
      <div class="found-body">
        <figure class="found-fig"><img src="${asset(`crops/${t.id}.jpg`)}" alt="${esc(t.title)}"></figure>
        <div class="found-text">
          ${revisit ? '' : `<p class="found-pts">Found it. ${points} point${points === 1 ? '' : 's'}.</p>`}
          <h2 id="found-title" tabindex="-1" data-focus>${esc(t.title)}</h2>
          <p class="story">${esc(t.story)}</p>
          <p class="closer"><strong>Look closer:</strong> ${esc(t.lookCloser)}</p>
          <div class="actions">
            ${next ? `<button class="btn primary" data-act="next">Find the next doll</button>` : `<button class="btn primary" data-act="finish">See your result</button>`}
            <button class="btn" data-act="list">Back to the list</button>
          </div>
        </div>
      </div>
    </section>`);
  if (!reduceMotion && !revisit) el.classList.add('reveal');
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'next' && next) huntScreen(next);
    else if (act === 'finish') finishedScreen();
    else if (act === 'list') listScreen();
  });
}

// ---------------------------------------------------------------- finished
function finishedScreen() {
  game.finish();
  const n = game.foundCount();
  const all = n === TARGETS.length;
  const tiles = TARGETS.map((t) => game.isFound(t.id)
    ? `<li><img src="${asset(`crops/${t.id}.jpg`)}" alt="${esc(t.title)}"></li>`
    : `<li class="missing"><span>Not found</span></li>`).join('');
  const el = mount(`
    <main class="screen finished">
      ${border}
      <div class="finished-body">
        <h2 data-focus tabindex="-1">${all ? 'All nine found' : `You found ${n} of ${TARGETS.length}`}</h2>
        <p class="lede">${game.score()} of ${game.maxScore()} points${game.elapsedText() ? `, ${game.elapsedText()}` : ''}.</p>
        <ul class="mosaic">${tiles}</ul>
        <div class="actions">
          <button class="btn primary" data-act="share">Share your result</button>
          ${all ? '' : '<button class="btn" data-act="list">Keep hunting</button>'}
          <button class="btn quiet" data-act="again">Play again</button>
        </div>
        <p class="note share-note" role="status"></p>
      </div>
    </main>`);
  el.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'share') {
      const how = await shareResult();
      el.querySelector('.share-note')!.textContent = how === 'downloaded' ? 'Saved golu-hunt.png.' : '';
    } else if (act === 'list') {
      game.progress.finishedAt = null; game.save(); listScreen();
    } else if (act === 'again') {
      if (confirm('Clear your finds and play again?')) { game.reset(); startScreen(); }
    }
  });
}

// ---------------------------------------------------------------- boot
if (game.progress.startedAt) {
  if (mode === 'camera') recognizer.load();
  listScreen();
} else {
  startScreen();
}
