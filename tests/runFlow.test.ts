import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { FlowDefinition, FlowStep, runFlow } from '../src/flows.js';

// Helper to build a minimal HTML page served via data URL with desired markup
function dataUrl(html: string) {
  return 'data:text/html;base64,' + Buffer.from(`<!DOCTYPE html><html><head><meta charset=utf-8 /><title>T</title></head><body>${html}</body></html>`).toString('base64');
}

async function withBrowser(fn: (page: any) => Promise<void>) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try { await fn(page); } finally { await browser.close(); }
}

// Build a flow with a label fallback target (button text) and a selector variant case
function buildFlow(url: string): FlowDefinition {
  const steps: FlowStep[] = [
    { action: 'goto', url },
    { action: 'wait', ms: 200 },
    // Variant: The real element has classes separated by space; we provide a brittle version requiring variant resolution
    { action: 'click', selector: 'div.wrapper>button.primary btn-main', label: 'Primary Action' },
    { action: 'wait', selector: 'input.search-box', ms: 1000, optional: true },
    { action: 'type', selector: 'input.search-box', text: 'demo', optional: true },
    { action: 'scroll', y: 400, smooth: true },
    { action: 'broll', duration: 300 },
  ];
  return { steps };
}

test('runFlow executes core actions including selector variant & label fallback', async () => {
  console.log('[test] starting runFlow integration test');
  await withBrowser(async (page) => {
    const html = `
      <div class="wrapper">
        <button class="primary btn-main">Primary Action</button>
      </div>
      <input class="search-box" placeholder="Search" />
      <div style="height:2000px"></div>
    `;
    const flow = buildFlow(dataUrl(html));

    const events = await runFlow(page, flow, { speed: 4 }); // faster

    // Basic assertions
    assert.ok(events.find(e => e.type === 'goto'), 'goto event emitted');

    // Click should succeed via variant resolution (selector variant or label fallback)
    const clickEvent = events.find(e => e.type === 'click');
    assert.ok(clickEvent, 'click event emitted');

    // Type step optional; may emit type events if input focused & typed
    const typeCharEvents = events.filter(e => e.type === 'type-char');
    assert.ok(typeCharEvents.length === 0 || typeCharEvents.length === 'demo'.length, 'type-char events count consistent');

    // Wait events should be recorded
    const waitEvents = events.filter(e => e.type === 'wait');
    assert.ok(waitEvents.length >= 1, 'at least one wait event');

    // Scroll event
    assert.ok(events.find(e => e.type === 'scroll'), 'scroll event emitted');

    // Broll event
    assert.ok(events.find(e => e.type === 'broll'), 'broll event emitted');
  });
});

test('runFlow dismisses blocking overlay to allow click & type', async () => {
  await withBrowser(async (page) => {
    const html = `
      <style>
        #helpOverlay { position:fixed; inset:0; background:rgba(0,0,0,.6); }
        #helpOverlay.open { display:block; }
        #helpOverlay:not(.open) { display:none; }
      </style>
      <div id="helpOverlay" class="open"><button id="close">Close</button></div>
      <input id="title" type="text" />
      <button id="themeToggle">Theme</button>
    `;
    const flow: FlowDefinition = { steps: [
      { action: 'goto', url: dataUrl(html) },
      { action: 'click', selector: 'button#themeToggle', label: 'Theme' },
      { action: 'type', selector: 'input#title', text: 'demo' },
    ] } as any;
    const events = await runFlow(page, flow, { speed: 6 });
    // Should have been able to click and type despite overlay initially present
    const clickEv = events.find(e=> e.type==='click');
    assert.ok(clickEv, 'click event emitted with overlay present');
    const typed = events.filter(e=> e.type==='type-char');
    assert.equal(typed.length, 'demo'.length, 'typed all chars');
  });
});
