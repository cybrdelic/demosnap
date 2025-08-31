import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Browser, chromium, Page } from 'playwright';
import { createStudioServer } from '../src/studio-server.js';

const STUDIO_PORT = Number(process.env.STUDIO_PORT || 7799); // override-able
const ACTION_LIMIT = Number(process.env.ACTION_LIMIT || 3);
const E2E_FULL = process.env.E2E_FULL === '1';
const HEADLESS = process.env.HEADLESS !== '0' && process.env.HEADED !== '1';
const CAM_STYLE = process.env.CAM_STYLE || ''; // e.g. 'cinematic' once implemented
// We now target the studio itself (self-referential capture) instead of a synthetic test page.

async function withStudio(fn: (studioUrl: string) => Promise<void>) {
  const app = createStudioServer();
  const server = app.listen(STUDIO_PORT);
  const studioUrl = `http://localhost:${STUDIO_PORT}`;
  try {
    await new Promise((r) => setTimeout(r, 400));
    await fn(studioUrl);
  } finally {
    if (!process.env.KEEP_STUDIO) server.close();
    else console.log(`[studio-ui-flow] KEEP_STUDIO=1 set; server still running at ${studioUrl}`);
  }
}

async function withBrowser(fn: (browser: Browser, page: Page) => Promise<void>) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: process.env.SLOWMO ? Number(process.env.SLOWMO) : undefined,
  });
  const page = await browser.newPage();
  try {
    await fn(browser, page);
  } finally {
    await browser.close();
  }
}

// Helper: wait for condition with polling (Playwright locator sometimes not enough for streaming events)
async function waitFor<T>(
  timeoutMs: number,
  fn: () => Promise<T | undefined | false> | (T | undefined | false),
  label = 'condition'
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val as T;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timeout waiting for ' + label);
}

// Full dogfooding path: open studio, generate flow for its own test page, build timeline via UI and compose.
test('Studio UI end-to-end self composition flow', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (_browser, page) => {
      // 1. Open studio
      let urlWithCam = studioUrl;
      const qp: string[] = [];
      if (CAM_STYLE) qp.push('cam=' + encodeURIComponent(CAM_STYLE));
      if (E2E_FULL) qp.push('long=1');
      if (qp.length) urlWithCam += (urlWithCam.includes('?') ? '&' : '?') + qp.join('&');
      await page.goto(urlWithCam);
      await page.waitForSelector('#url', { timeout: 5000 });

      // 2. Input studio URL & title/subtitle for self-video
      const studioTarget = studioUrl + '/';
      await page.fill('#url', studioTarget);
      await page.fill('#title', 'Studio Self E2E');
      await page.fill('#subtitle', 'Studio UI capture');
      // 3. Trigger auto-flow discovery (streaming)
      await page.click('#generateBtn');

      // Wait for at least one candidate
      await waitFor(
        15000,
        async () => {
          const count = await page
            .locator('#actionCandidates .action-item')
            .count()
            .catch(() => 0);
          return count > 0 ? count : undefined;
        },
        'action candidates'
      );

      // 4. Select a few safe actions (avoid Compose button to prevent recursion)
      const all = await page.locator('#actionCandidates .action-item').elementHandles();
      const usedSelectors = new Set<string>();
      let picked = 0;
      for (const h of all) {
        const txt = (await h.textContent()) || '';
        if (/compose|delete|close|purge|help/i.test(txt)) continue; // avoid studio internal / destructive
        // Extract underlying selector from title attribute
        const selector = await h.getAttribute('title');
        if (selector && usedSelectors.has(selector)) continue; // ensure diversity
        if (selector && /(delete|close|purge|help|composeBtn)/i.test(selector)) continue;
        await h.click();
        if (selector) usedSelectors.add(selector);
        picked++;
        if (!E2E_FULL && picked >= ACTION_LIMIT) break;
      }

      // Assert timeline shows steps count > 0
      const stepsCountText = await page.textContent('#yamlSteps');
      assert.ok(Number(stepsCountText) > 0, 'Timeline should have at least one step');

      // 5. Compose via UI (submits YAML) exactly once at this point
      await page.click('#composeBtn');

      // 6. Wait for job status to become Complete OR preview video appears
      await waitFor(
        120000,
        async () => {
          const status = await page.textContent('#jobStatus').catch(() => '');
          if (status?.includes('Complete')) return status;
          const hasVideo = await page
            .locator('#previewArea video')
            .count()
            .catch(() => 0);
          return hasVideo > 0 ? 'VideoReady' : undefined;
        },
        'composition completion'
      );

      // 7. Extract job id from preview video source
      const src = await page.getAttribute('#previewArea video source', 'src');
      assert.ok(
        src && /studio_out\/job_\d+\/composed\.webm/.test(src),
        'Video source path pattern'
      );
      const jobIdMatch = src!.match(/job_\d+/);
      assert.ok(jobIdMatch, 'Job id present in video src');
      const jobId = jobIdMatch![0];

      // 8. Verify file exists on disk
      const videoPath = path.join(process.cwd(), 'studio_out', jobId, 'composed.webm');
      assert.ok(fs.existsSync(videoPath), 'Composed video file should exist');
      const stat = fs.statSync(videoPath);
      assert.ok(stat.size > 5000, 'Video file should have non-trivial size');

      // 8b. Inspect timeline.json for semantic cinematography events
      const timelinePath = path.join(process.cwd(), 'studio_out', jobId, 'timeline.json');
      assert.ok(fs.existsSync(timelinePath), 'timeline.json should exist');
      const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8')) as any[];
      const types = new Set(timeline.map((e) => e.type));
      assert.ok(types.has('establish'), 'timeline should contain establish event');
      // Soft semantics: only require load events if explicitly requested; log otherwise.
      const loadSemanticTypes = ['load-start', 'load-progress', 'load-complete', 'result-focus'];
      const hasLoadSemantic = loadSemanticTypes.some((t) => types.has(t));
      if (process.env.REQUIRE_LOAD_SEMANTICS === '1') {
        assert.ok(
          hasLoadSemantic,
          'REQUIRE_LOAD_SEMANTICS=1 but no load-start/load-complete/result-focus events present'
        );
      } else if (!hasLoadSemantic) {
        console.log(
          '[studio-ui-flow] (info) No load semantic events detected; this is expected when the tested UI has no observable network/indicator latency. Set REQUIRE_LOAD_SEMANTICS=1 to enforce.'
        );
      }

      // 9. Jobs API should list job as composed
      const jobsResp = await page.request.get(studioUrl + '/api/jobs');
      const jobs = await jobsResp.json();
      const job = jobs.find((j: any) => j.id === jobId);
      assert.ok(job && job.composed, 'Job should be marked composed');

      // 10. Human-friendly link output
      const videoUrl = `${studioUrl}/studio_out/${jobId}/composed.webm`;
      // Also provide a studio page anchor (user can open studio and refresh jobs then click Play)
      console.log(`\n[studio-ui-flow] Watch video: ${videoUrl}`);
      console.log(`[studio-ui-flow] Open studio: ${studioUrl} (Refresh -> Play on job ${jobId})`);
      console.log(
        `[studio-ui-flow] Params => HEADLESS=${HEADLESS} ACTION_LIMIT=${ACTION_LIMIT} CAM_STYLE=${CAM_STYLE || '(default logic)'} STUDIO_PORT=${STUDIO_PORT}`
      );
    });
  });
});
