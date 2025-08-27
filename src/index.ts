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
  // Compute duration via a quick browser probe (html5 video metadata) if possible
  let durationMs = 0;
  try {
    const probeBrowser = await (playwright as any).chromium.launch({ headless: true });
    const probeCtx = await probeBrowser.newContext();
    const probePage = await probeCtx.newPage();
    // Build a proper file:// URL that works on Windows and POSIX (encode URI components)
    const absNorm = target.replace(/\\/g,'/');
    const fileUrl = 'file://' + (absNorm.startsWith('/') ? absNorm : '/' + absNorm);
    durationMs = await probePage.evaluate(async (src: string) => new Promise<number>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      let done = false;
      const finish = (ms:number)=>{ if(!done){ done=true; resolve(ms); } };
      v.onloadedmetadata = () => finish(isFinite(v.duration)? Math.round(v.duration*1000):0);
      v.onerror = () => finish(0);
      // Fallback timeout in case onloadedmetadata never fires
      setTimeout(()=> finish(0), 4000);
      v.src = src;
    }), fileUrl);
    await probeBrowser.close();
    if (debug) console.log('[record] detected durationMs', durationMs);
  } catch (e) { if (debug) console.warn('[record] duration probe failed', e); }
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
    .parseSync() as unknown as CLIArgs;

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
  duration: durationMs ? durationMs + 1500 : 8000, // add a little tail for camera motion
    title: argv.title,
    subtitle: argv.subtitle,
    theme: argv.theme,
    timelineBase64: Buffer.from(JSON.stringify(events)).toString('base64'),
  debug: argv.debug,
  });
  server.close();
  console.log('Artifacts written:', { raw, composed: composedPath, cover: coverPath });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
