/*
  Launch a headless browser to load the Three.js compositor page that maps the raw capture video onto an isometric plane with a sky backdrop and records the output using MediaRecorder exposed via evaluate.
*/
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

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
}

export async function compose(options: ComposeOptions) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height } });
  const page = await context.newPage();
  const fileUrl = 'file://' + path.resolve(options.htmlPath);
  await page.goto(fileUrl + `?video=${encodeURIComponent(options.videoUrl)}&title=${encodeURIComponent(options.title ?? '')}&subtitle=${encodeURIComponent(options.subtitle ?? '')}&theme=${encodeURIComponent(options.theme ?? 'sky')}`);

  // Inject handler to start recording once video is ready in the webapp
  await page.exposeFunction('nodeDone', async (blobBase64: string, coverBase64: string) => {
    const buf = Buffer.from(blobBase64, 'base64');
    fs.writeFileSync(options.outVideo, buf);
    fs.writeFileSync(options.coverPath, Buffer.from(coverBase64, 'base64'));
  });

  // Wait for a global promise that compositor will resolve after playback and camera path
  await page.waitForFunction(() => (window as any).COMPOSITOR_READY === true, { timeout: 0 });
  await browser.close();
}
