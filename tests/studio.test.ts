import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, chromium, Page } from 'playwright';
import { createStudioServer } from '../src/studio-server.js';

const STUDIO_PORT = 7799; // Use different port for tests
const TEST_TIMEOUT = 30000;

async function withStudio(fn: (studioUrl: string) => Promise<void>) {
  const app = createStudioServer();
  const server = app.listen(STUDIO_PORT);

  try {
    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fn(`http://localhost:${STUDIO_PORT}`);
  } finally {
    server.close();
  }
}

async function withBrowser(fn: (browser: Browser, page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await fn(browser, page);
  } finally {
    await browser.close();
  }
}

test('Studio server starts and serves main page', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      const response = await page.goto(studioUrl);
      assert.ok(response?.ok(), 'Studio page should load successfully');

      // Check for key UI elements
      await page.waitForSelector('#url', { timeout: 5000 });
      await page.waitForSelector('#title');
      await page.waitForSelector('button[type="submit"]');

      const title = await page.title();
      assert.ok(title.includes('DemoSnap'), 'Page should have DemoSnap in title');
    });
  });
});

test('Studio API endpoints respond correctly', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      // Test /api/jobs endpoint
      const jobsResponse = await page.request.get(`${studioUrl}/api/jobs`);
      assert.equal(jobsResponse.status(), 200);

      const jobs = await jobsResponse.json();
      assert.ok(Array.isArray(jobs), 'Jobs endpoint should return an array');
    });
  });
});

test('Studio can generate auto-flow for a simple page', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      // Create a simple test page
      const testPageContent = `
        <input id="search" placeholder="Search...">
        <button id="submit">Submit</button>
        <a href="#link">Click me</a>
      `;
      const testPageUrl =
        'data:text/html;base64,' +
        Buffer.from(`<!DOCTYPE html><html><body>${testPageContent}</body></html>`).toString(
          'base64'
        );

      // Test auto-flow generation
      const autoFlowResponse = await page.request.post(`${studioUrl}/api/auto-flow`, {
        data: {
          url: testPageUrl,
          maxActions: 3,
        },
      });

      assert.equal(autoFlowResponse.status(), 200);
      const result = await autoFlowResponse.json();

      assert.ok(result.ok, 'Auto-flow should succeed');
      assert.ok(result.yaml, 'Should return YAML flow');
      assert.ok(result.yaml.includes('steps:'), 'YAML should contain steps');
      assert.ok(result.candidates?.length > 0, 'Should find interactive candidates');
    });
  });
});

test('Compositor loads and initializes correctly', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      // Navigate to compositor with basic parameters
      const compositorUrl = `${studioUrl}/compositor.html?theme=minimal&fallbackDuration=3000&cam=default`;

      // Set up console monitoring
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.text().includes('[compositor]')) {
          consoleLogs.push(msg.text());
        }
      });

      await page.goto(compositorUrl);

      // Wait for compositor to initialize
      await page.waitForFunction(() => (window as any).__COMPOSITOR_RAN, { timeout: 10000 });

      // Check that the root element exists
      const rootElement = await page.locator('#root');
      const isVisible = await rootElement.isVisible();
      assert.ok(isVisible, 'Root element should be visible');

      // Verify compositor logs indicate proper initialization
      assert.ok(
        consoleLogs.some((log) => log.includes('Scene initialized')),
        'Compositor should log scene initialization'
      );
    });
  });
});

test('Compositor signals ready within timeout', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      const compositorUrl = `${studioUrl}/compositor.html?theme=minimal&fallbackDuration=3000&cam=default`;

      await page.goto(compositorUrl);

      // Wait for COMPOSITOR_READY to be set
      await page.waitForFunction(() => (window as any).COMPOSITOR_READY, { timeout: 15000 });

      const isReady = await page.evaluate(() => (window as any).COMPOSITOR_READY);
      assert.ok(isReady, 'COMPOSITOR_READY should be set to true');
    });
  });
});

test('Video recording duration is enforced correctly', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      // Use a short fallbackDuration for faster testing
      const compositorUrl = `${studioUrl}/compositor.html?theme=minimal&fallbackDuration=2000&cam=default&debug=1`;

      const recordingLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.text().includes('Recording') || msg.text().includes('recording')) {
          recordingLogs.push(msg.text());
        }
      });

      await page.goto(compositorUrl);

      // Wait for recording to start and complete
      await page.waitForFunction(() => (window as any).COMPOSITOR_READY, { timeout: 15000 });

      // Verify recording logs show correct duration
      const startLog = recordingLogs.find((log) => log.includes('Recording started'));
      const stopLog = recordingLogs.find(
        (log) => log.includes('Recording stopped') || log.includes('Stopping recording')
      );

      assert.ok(startLog, 'Should log recording start');
      assert.ok(stopLog, 'Should log recording stop');

      // Check that minimum duration was enforced (should be at least 8 seconds)
      if (startLog?.includes('will stop after:')) {
        const durationMatch = startLog.match(/will stop after:\s*(\d+)/);
        if (durationMatch) {
          const duration = parseInt(durationMatch[1]);
          assert.ok(
            duration >= 8000,
            `Recording duration should be at least 8000ms, got ${duration}ms`
          );
        }
      }
    });
  });
});

test('Video looping prevents early recording termination', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      const compositorUrl = `${studioUrl}/compositor.html?theme=minimal&fallbackDuration=4000&cam=default&debug=1`;

      const videoLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.text().includes('video')) {
          videoLogs.push(msg.text());
        }
      });

      await page.goto(compositorUrl);

      // Wait for video to load and compositor to be ready
      await page.waitForFunction(() => (window as any).COMPOSITOR_READY, { timeout: 15000 });

      // Check that video looping is enabled
      const loopStatus = videoLogs.find((log) => log.includes('video.loop:'));
      assert.ok(loopStatus?.includes('true'), 'Video loop should be enabled');

      // Verify that even if video ends, recording continues
      const endedLogs = videoLogs.filter((log) => log.includes('video ended'));
      if (endedLogs.length > 0) {
        // If video ended, it should mention looping
        assert.ok(
          endedLogs.some((log) => log.includes('but should loop')),
          'Video end should acknowledge looping'
        );
      }
    });
  });
});

test('Shader development panel works correctly', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      const compositorUrl = `${studioUrl}/compositor.html?theme=minimal&shaderDev=1&fallbackDuration=2000`;

      await page.goto(compositorUrl);

      // Wait for compositor to initialize
      await page.waitForFunction(() => (window as any).__COMPOSITOR_RAN, { timeout: 10000 });

      // Check if shader dev panel is visible
      // Note: We need to wait a bit for React to render
      await page.waitForTimeout(1000);

      // The shader dev panel should be rendered by React
      const hasShaderDevAPI = await page.evaluate(() => (window as any).shaderDev !== undefined);
      assert.ok(hasShaderDevAPI, 'Shader dev API should be available on window');
    });
  });
});

test('Studio compose endpoint creates video successfully', async () => {
  await withStudio(async (studioUrl) => {
    await withBrowser(async (browser, page) => {
      // Create a simple test page
      const testPageContent = '<h1>Test Page</h1><button>Click me</button>';
      const testPageUrl =
        'data:text/html;base64,' +
        Buffer.from(`<!DOCTYPE html><html><body>${testPageContent}</body></html>`).toString(
          'base64'
        );

      // Test compose endpoint with short duration for faster testing
      const composeResponse = await page.request.post(`${studioUrl}/api/compose`, {
        data: {
          url: testPageUrl,
          title: 'Test Video',
          subtitle: 'Test Subtitle',
        },
        timeout: TEST_TIMEOUT,
      });

      assert.equal(composeResponse.status(), 200);
      const result = await composeResponse.json();

      assert.ok(result.ok, 'Compose should succeed');
      assert.ok(result.id, 'Should return job ID');
      assert.ok(result.composed, 'Should return composed video path');
      assert.ok(result.cover, 'Should return cover image path');

      // Verify the files exist
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(result.composed), 'Composed video file should exist');
      assert.ok(fs.existsSync(result.cover), 'Cover image file should exist');

      // Check file sizes are reasonable (not empty)
      const videoStats = fs.statSync(result.composed);
      const coverStats = fs.statSync(result.cover);

      assert.ok(videoStats.size > 1000, 'Video file should be substantial size');
      assert.ok(coverStats.size > 1000, 'Cover image should be substantial size');
    });
  });
});
