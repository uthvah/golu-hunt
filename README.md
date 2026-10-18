# Golu Hunt

Find nine dolls on the golu with your phone's camera and unlock their stories. Recognition runs entirely in the browser: no server, no uploads.

There are two ways to play:

- **Camera mode.** Point the reticle at a doll. An embedding model (DINOv2-small) compares what the camera sees with reference views of each doll.
- **Photo mode.** Pan and zoom a photo of the middle staircase and tap the doll. It needs no model and keeps working after the golu is packed away.

## Quick start

```bash
npm install
npm run build-index   # downloads the model once (~25 MB), takes a few minutes
npm run self-test     # checks the index: aim for ≥ 90% accuracy
npm run dev           # play on your laptop at http://localhost:5173
```

The camera needs HTTPS, except on `localhost`. A phone opening `http://192.168…` won't get camera access. To test on a phone, either deploy (below) or add [`@vitejs/plugin-basic-ssl`](https://github.com/vitejs/vite-plugin-basic-ssl) to `vite.config.ts` and accept the certificate warning. Photo mode works over plain http.

`npm install` downloads native binaries for `onnxruntime-node` and `sharp`, so it needs normal internet access.

## Fixing the boxes

`data/boxes.json` holds the 27 boxes (each doll in its close-up, in photo 03 and in photo 01). They were estimated by eye and are close, but not exact.

1. Run `npm run dev` and open `/annotate.html`.
2. Pick a photo and a doll, then drag a box around the doll.
3. Click "Download boxes.json" and save it over `data/boxes.json`.
4. Run `npm run build-index` and `npm run self-test` again.

To see what the augmentation does, run `npm run build-index -- --preview` and look in `build/preview/`.

## Calibrating in front of the golu

Open the site with `?debug` (for example `https://…/golu-hunt/?debug`). A panel shows the top match, s1, s2, votes and fps.

1. For each doll, stand 0.5 m, 1 m and 2 m away, with the fairy lights on and then off.
2. Type a tag such as `kannappa 1m lights-on`, press Record, hold for about 5 seconds, then press Stop.
3. Do one sweep across dolls that aren't targets, tagged `negatives`.
4. Download the CSV.

Set τ midway between the lowest `sTarget` of genuine 1 m frames and the highest `sTarget` seen during the negatives sweep. You can try thresholds without rebuilding: `?tau=0.6&margin=0.04&votes=4`. Once you're happy, change `DEFAULT_DECIDE` in `src/match.ts`.

If a doll won't confirm from 1 m, extract frames from a short video of it, add them as extra photos and boxes, and rebuild the index.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository, including `public/index.bin` and `public/index.json`.
2. In the repository settings, set Pages to use GitHub Actions as the source.
3. Every push to `main` deploys via `.github/workflows/deploy.yml`.
4. Print a QR code of the URL and put the Wi-Fi details next to it.

The first camera-mode load downloads about 30 MB: the 8-bit model (24 MB) plus the ONNX runtime. The browser caches both.

## How it works

| Piece | File |
| --- | --- |
| Model loading and embedding, shared by Node and the browser | `src/embed.ts` |
| Index format, kNN scoring, decision rule, 5-of-7 stabiliser | `src/match.ts` |
| Location estimate and hint wording | `src/locate.ts` |
| Index build: crops, augmentation, landmark tiles, negatives | `scripts/build-index.ts` |
| Leave-one-source-out test | `scripts/self-test.ts` |
| Recognition loop (Web Worker) and its client | `src/worker.ts`, `src/recognizer.ts` |
| Camera and reticle-aligned cropping | `src/camera.ts`, `src/hunt-camera.ts` |
| Photo mode | `src/photo-mode.ts` |
| Screens, scoring, saved progress, share image | `src/main.ts`, `src/game.ts`, `src/share.ts` |

Ways this differs from the blueprint:

- The index is stored as int8 rather than float16. It's half the size, and cosine scores change by less than 0.01.
- WebGPU is opt-in (`?gpu`) rather than automatic. The default 8-bit WASM model uses the same weights the index was built with. WebGPU would need the 88 MB fp32 model, whose embeddings differ slightly from the index.

## Content

- The stories are in `data/stories.json`. The `lap` doll's story is a placeholder until you confirm who it is.
- Doll positions and step numbers are in `data/targets.json`.
- The staircase geometry used for hints is in `data/layout.json`.
