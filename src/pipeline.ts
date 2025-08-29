import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as playwright from 'playwright';
import { createServer } from './compositor-server.js';
import { compose } from './compositor.js';
import { FlowDefinition, loadFlow, runFlow } from './flows.js';

export interface PipelineOptions {
  url: string;             // target URL to open (if no custom flow)
  title?: string;
  subtitle?: string;
  outDir: string;          // output directory for artifacts
  width?: number;
  height?: number;
  theme?: string;
  minDuration?: number;    // ensure at least this long capture
  speed?: number;
  flowPath?: string;       // optional user-supplied flow YAML path
  debug?: boolean;
  videoBitrateKbps?: number;
  fps?: number;
  quality?: string;
  link?: string;
  letterbox?: boolean;
}

export interface PipelineResult {
  raw: string;
  composed: string;
  cover: string;
  events: any[];
}

async function recordRaw(flow: FlowDefinition, opts: Required<Pick<PipelineOptions,'outDir'|'width'|'height'|'speed'|'minDuration'|'debug'>>) {
  const { outDir, width, height, speed, minDuration, debug } = opts;
  const browser = await (playwright as any).chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: outDir, size: { width, height } } });
  const page = await context.newPage();
  if (debug) console.log('[pipeline] recording context ready');
  // Ensure goto present for reliability
  if (!flow.steps.some(s=> (s as any).action === 'goto')) {
    flow.steps.unshift({ action: 'goto', url: flow.name || 'about:blank' } as any);
  }
  const startTs = Date.now();
  const events = await runFlow(page, flow, { speed });
  const elapsed = Date.now() - startTs;
  const remaining = Math.max(0, minDuration - elapsed);
  await page.waitForTimeout(remaining > 0 ? remaining : 400);
  const pv = page.video();
  if (!pv) throw new Error('No page.video from Playwright');
  await page.close();
  await context.close();
  const tempPath = await pv.path();
  // Poll size until non-zero
  for (let i=0;i<30;i++) { const size = fs.statSync(tempPath).size; if (size>0) break; await new Promise(r=>setTimeout(r,150)); }
  const target = path.join(outDir, 'raw.webm');
  fs.copyFileSync(tempPath, target);
  await browser.close();
  return { raw: target, events };
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const speed = options.speed ?? 1;
  const theme = options.theme ?? 'minimal';
  const minDuration = options.minDuration ?? 6000;
  const quality = options.quality ?? 'auto';
  const link = options.link;
  const letterbox = options.letterbox !== false;
  fs.mkdirSync(options.outDir, { recursive: true });

  let flow: FlowDefinition;
  if (options.flowPath) {
    flow = loadFlow(options.flowPath);
  } else {
    flow = {
      name: options.url,
      viewport: { width, height },
      steps: [
        { action: 'goto', url: options.url },
        { action: 'broll', duration: Math.max(3000, minDuration - 1500) }
      ] as any
    };
  }

  const { raw, events } = await recordRaw(flow, { outDir: options.outDir, width, height, speed, minDuration, debug: !!options.debug });

  // Start ephemeral server to serve raw video for composition
  const app = createServer(raw);
  const server = http.createServer(app);
  await new Promise<void>(res => server.listen(0, res));
  const port = (server.address() as any).port;
  const videoUrl = `http://localhost:${port}/video`;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const htmlPath = path.join(__dirname, '..', 'public', 'compositor.html');
  const composedPath = path.resolve(options.outDir, 'composed.webm');
  const coverPath = path.resolve(options.outDir, 'cover.png');
  await compose({
    htmlPath,
    videoUrl,
    outVideo: composedPath,
    coverPath,
    width,
    height,
    duration: Math.max(minDuration, 8000),
    title: options.title,
    subtitle: options.subtitle,
  theme,
    timelineBase64: Buffer.from(JSON.stringify(events)).toString('base64'),
    debug: options.debug,
    videoBitrateKbps: options.videoBitrateKbps ?? 10000,
    fps: options.fps ?? 30,
    quality,
    link,
    letterbox,
  hud: 'minimal'
  });
  server.close();
  // Persist timeline events for client-side HUD previews
  try {
    const timelinePath = path.join(options.outDir, 'timeline.json');
    fs.writeFileSync(timelinePath, JSON.stringify(events, null, 2));
  } catch(e) { console.warn('[pipeline] failed writing timeline.json', e); }
  return { raw, composed: composedPath, cover: coverPath, events };
}
