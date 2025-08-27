/*
  Launch a headless browser to load the Three.js compositor page that maps the raw capture video onto an isometric plane with a sky backdrop and records the output using MediaRecorder exposed via evaluate.
*/
import fs from 'node:fs';
import path from 'node:path';
import * as playwright from 'playwright';

export interface ComposeOptions {
  htmlPath: string; // path to compositor.html
  videoUrl: string; // URL served pointing to raw capture
  outVideo: string; // output composed video path
  coverPath: string; // png screenshot
  width: number;
  height: number;
  duration: number; // expected playback duration (ms)
  title?: string;
  subtitle?: string;
  theme?: string;
  timelineBase64?: string; // optional base64 of events
  debug?: boolean;
}

export async function compose(options: ComposeOptions) {
  const browser = await (playwright as any).chromium.launch({ headless: true });
  const recordDir = path.join(path.dirname(options.outVideo), '___compose_tmp');
  fs.mkdirSync(recordDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    recordVideo: { dir: recordDir, size: { width: options.width, height: options.height } }
  });
  const page = await context.newPage();
  page.on('console', (msg: any) => { try { console.log('[compose page]', msg.type(), msg.text()); } catch {} });
  // Attach request/response listeners BEFORE navigation to capture compositor.js request
  page.on('request', (req:any)=> options.debug && console.log('[compose req early]', req.method(), req.url()));
  page.on('response', (res:any)=> options.debug && console.log('[compose res early]', res.status(), res.url()));
  // Derive base origin from videoUrl (http://localhost:PORT)
  let origin = '';
  try { const u = new URL(options.videoUrl); origin = `${u.protocol}//${u.host}`; } catch {}
  const debug = options.debug ? '&debug=1' : '';
  const url = origin + `/compositor?video=${encodeURIComponent(options.videoUrl)}&title=${encodeURIComponent(options.title ?? '')}&subtitle=${encodeURIComponent(options.subtitle ?? '')}&theme=${encodeURIComponent(options.theme ?? 'sky')}&timeline=${encodeURIComponent(options.timelineBase64 ?? '')}&fallbackDuration=${encodeURIComponent(String(options.duration || 0))}${debug}`;
  console.log('[compose] navigate URL', url);
  // Expose nodeDone BEFORE navigation so page scripts can call immediately
  await page.exposeFunction('nodeDone', async (blobBase64: string, coverBase64: string) => {
    try {
      if (blobBase64) {
        const buf = Buffer.from(blobBase64, 'base64');
        fs.writeFileSync(options.outVideo, buf);
      }
      if (coverBase64) fs.writeFileSync(options.coverPath, Buffer.from(coverBase64, 'base64'));
      console.log('[compose] nodeDone wrote artifacts', {
        videoSize: fs.existsSync(options.outVideo)? fs.statSync(options.outVideo).size: 0,
        coverSize: fs.existsSync(options.coverPath)? fs.statSync(options.coverPath).size: 0,
      });
    } catch (e) { console.error('[compose] nodeDone error', e); }
  });
  console.log('[compose] starting navigation');
  await page.goto(url, { waitUntil: 'load' });
  console.log('[compose] page load complete');
  page.on('pageerror', (err:any)=> console.error('[compose pageerror]', err));
  page.on('request', (req:any)=> options.debug && console.log('[compose req]', req.method(), req.url()));
  page.on('requestfailed', (req:any)=> console.warn('[compose req FAILED]', req.failure()?.errorText, req.url()));
  page.on('response', async (res:any)=> { if(options.debug){ console.log('[compose res]', res.status(), res.url()); } });
  // Snapshot environment
  try {
    const info = await page.evaluate(() => ({
      readyState: document.readyState,
      scripts: Array.from(document.scripts).map(s=>({src:s.src,type:s.type})),
      hasNodeDone: typeof (window as any).nodeDone === 'function',
      location: location.href,
    }));
    console.log('[compose] page info', info);
  } catch(e){ console.warn('[compose] eval page info failed', e); }
  const maxWait = Math.max(6000, options.duration + 4000);
  console.log('[compose] waiting for __COMPOSITOR_BOOT');
  await page.waitForFunction(() => (window as any).__COMPOSITOR_BOOT === true, { timeout: 10000 }).then(()=>console.log('[compose] __COMPOSITOR_BOOT detected')).catch(()=>console.warn('[compose] __COMPOSITOR_BOOT timeout'));
  // If still not detected, inject fallback marker and log DOM snapshot
  const bootPresent = await page.evaluate('window.__COMPOSITOR_BOOT === true');
  if (!bootPresent) {
    console.warn('[compose] boot marker missing after wait; injecting fallback');
    try {
      const info = await page.evaluate(()=>({html: document.documentElement.outerHTML.slice(0,1000)}));
      console.log('[compose] DOM head snippet', info.html);
    } catch(e){ console.warn('[compose] failed DOM snapshot', e); }
    await page.evaluate(()=>{ (window as any).__COMPOSITOR_BOOT = true; });
  }
  console.log('[compose] waiting for COMPOSITOR_READY up to', maxWait,'ms');
  const startWait = Date.now();
  await page.waitForFunction(() => (window as any).COMPOSITOR_READY === true, { timeout: maxWait }).then(()=>{
    console.log('[compose] COMPOSITOR_READY detected after', Date.now()-startWait,'ms');
  }).catch(()=>{
    console.warn('[compose] COMPOSITOR_READY timeout after', Date.now()-startWait,'ms');
  });
  // Capture cover if recorder didn't provide one
  if (!fs.existsSync(options.coverPath) || fs.statSync(options.coverPath).size === 0) {
    try {
      const coverBuf = await page.screenshot({ type: 'png' });
      fs.writeFileSync(options.coverPath, coverBuf);
    } catch (e) { console.warn('[compose] cover screenshot fallback failed', e); }
  }
  const pv = page.video();
  await page.close();
  await context.close();
  if ((!fs.existsSync(options.outVideo) || fs.statSync(options.outVideo).size === 0) && pv) {
    try {
      const p = await pv.path();
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, options.outVideo);
        console.log('[compose] wrote composed video from playwright record', p);
      }
    } catch (e) { console.error('[compose] failed copying playwright video', e); }
  }
  await browser.close();
}
