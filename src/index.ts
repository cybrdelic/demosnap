#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as playwright from 'playwright';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createServer } from './compositor-server.js';
import { compose } from './compositor.js';
import { loadFlow, runFlow } from './flows.js';

interface CLIArgs {
  flow: string;
  out: string;
  width: number;
  height: number;
  theme: string;
  title?: string;
  subtitle?: string;
  speed: number;
  debug: boolean;
  minDuration: number;
  serve: boolean;
  videoBitrate: number;
  fps: number;
  quality: string;
  link?: string;
}

async function recordRaw(
  fallbackUrl: string,
  flowPath: string,
  outDir: string,
  width: number,
  height: number,
  speed: number,
  debug: boolean,
  minDuration: number,
) {
  const flow = loadFlow(flowPath);
  if (flow.viewport) { width = flow.viewport.width; height = flow.viewport.height; }
  const browser = await (playwright as any).chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: outDir, size: { width, height } } });
  const page = await context.newPage();
  if (debug) console.log('[record] context created');
  if (!flow.steps.some(s => s.action === 'goto')) {
    await page.goto(fallbackUrl, { waitUntil: 'load' });
  }
  const startTs = Date.now();
  const events = await runFlow(page, flow, { speed });
  if (debug) console.log('[record] flow finished');
  // Ensure minimum extra buffer for final animations / network idle
  const elapsed = Date.now() - startTs;
  const remaining = Math.max(0, minDuration - elapsed);
  if (remaining > 0) {
    if (debug) console.log('[record] padding', remaining, 'ms to reach minDuration');
    await page.waitForTimeout(remaining);
  } else {
    await page.waitForTimeout(400); // short tail to flush network/rendering
  }
  const pv = page.video();
  if (!pv) throw new Error('Playwright did not provide page.video()');
  await page.close();
  if (debug) console.log('[record] page closed, flushing context');
  await context.close();
  const tempPath = await pv.path();
  if (debug) console.log('[record] temp video path', tempPath);
  // Some environments need manual saveAs() for reliability
  try {
    if ((pv as any).saveAs) {
      const altPath = path.join(outDir, 'raw_tmp.webm');
      await (pv as any).saveAs(altPath);
      if (fs.existsSync(altPath) && fs.statSync(altPath).size > 0) {
        if (debug) console.log('[record] used saveAs alt path');
        fs.unlinkSync(tempPath); // discard original if duplicate
        fs.renameSync(altPath, tempPath);
      }
    }
  } catch (e) { if (debug) console.warn('[record] saveAs failed', e); }
  await browser.close();
  if (!fs.existsSync(tempPath)) throw new Error('Video temp path missing after close');
  // Poll for non-zero size
  for (let i=0;i<30;i++) {
    const size = fs.statSync(tempPath).size;
    if (size > 0) break;
    await new Promise(r=>setTimeout(r,150));
  }
  const target = path.join(outDir, 'raw.webm');
  fs.copyFileSync(tempPath, target);
  const stat = fs.statSync(target);
  if (stat.size === 0) throw new Error('Recorded video is empty after flush');
  if (debug) console.log('[record] raw size', stat.size);
  // Optional duration probe removed for Windows reliability; compositor will use video.duration directly.
  const durationMs = 0; // 0 => let compositor fallback logic decide
  if (debug) console.log('[record] skipping duration probe (set to 0; compositor will infer)');
  return { raw: target, durationMs, events };
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('flow', { type: 'string', demandOption: true })
    .option('out', { type: 'string', demandOption: true })
    .option('width', { type: 'number', default: 1280 })
    .option('height', { type: 'number', default: 720 })
    .option('theme', { type: 'string', default: 'sky' })
    .option('title', { type: 'string' })
    .option('subtitle', { type: 'string' })
    .option('speed', { type: 'number', default: 1, describe: 'Interaction speed multiplier (>1 faster, <1 slower)' })
  .option('debug', { type: 'boolean', default: false })
  .option('minDuration', { type: 'number', default: 6000, describe: 'Minimum ms to keep recording open (pads if flow shorter)' })
  .option('serve', { type: 'boolean', default: false, describe: 'Keep a local player server running after generation' })
  .option('videoBitrate', { type: 'number', default: 10000, describe: 'Target composed video bitrate (kbps) hint to MediaRecorder' })
  .option('fps', { type: 'number', default: 30, describe: 'Capture FPS (e.g. 30, 45, 60). Higher = smoother + larger file.' })
  .option('quality', { type: 'string', default: 'auto', choices: ['auto','high','max'], describe: 'Compositor quality preset (dynamic scale, high, or locked max)' })
  .option('link', { type: 'string', describe: 'Product / CTA URL to embed & log' })
    .parseSync() as unknown as CLIArgs;

  // Auto-enable serve if a link / CTA provided (so user can open player after run)
  if (argv.link && !argv.serve) argv.serve = true;

  fs.mkdirSync(argv.out, { recursive: true });
  console.log('Recording raw flow...');
  const { raw, durationMs, events } = await recordRaw('https://example.com', argv.flow, argv.out, argv.width, argv.height, argv.speed, argv.debug, argv.minDuration);
  console.log('Raw recording saved:', raw);

  // Start server to feed video file
  const app = createServer(raw);
  const server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, res));
  const port = (server.address() as any).port;
  const videoUrl = `http://localhost:${port}/video`;

  const composedPath = path.join(argv.out, 'composed.webm');
  const coverPath = path.join(argv.out, 'cover.png');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const htmlPath = path.join(__dirname, '..', 'public', 'compositor.html');
  console.log('Compositing cinematic view...');
  await compose({
    htmlPath,
    videoUrl,
    outVideo: composedPath,
    coverPath,
    width: argv.width,
    height: argv.height,
  // If durationMs==0 compositor will rely on video metadata; provide generous fallback min
  duration: durationMs ? durationMs + 1500 : Math.max(argv.minDuration, 8000),
    title: argv.title,
    subtitle: argv.subtitle,
    theme: argv.theme,
    timelineBase64: Buffer.from(JSON.stringify(events)).toString('base64'),
  debug: argv.debug,
  videoBitrateKbps: argv.videoBitrate,
  fps: argv.fps,
  quality: argv.quality,
  link: argv.link,
  });
  // Add composed route before optionally serving
  (app as any).get && (app as any).get('/composed', (_req:any,res:any)=> res.sendFile(composedPath));
  console.log('Artifacts written:', { raw, composed: composedPath, cover: coverPath });
  const playerComposed = `http://localhost:${port}/player?src=${encodeURIComponent(`http://localhost:${port}/composed`)}${argv.link?`&cta=${encodeURIComponent(argv.link)}`:''}`;
  console.log('[player] Local player (composed):', playerComposed);
  console.log('[player] Local player (raw):', `http://localhost:${port}/player?src=${encodeURIComponent(videoUrl)}`);
  if (argv.link) console.log('[player] CTA link:', argv.link);
  if (argv.serve) {
    console.log('[serve] Server running. Press Ctrl+C to exit.');
    await new Promise(()=>{}); // keep alive
  } else {
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
