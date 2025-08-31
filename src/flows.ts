import fs from 'node:fs';
import YAML from 'yaml';
// Fallback: explicit any for Page to avoid type resolution issues
type Page = any;

// Each step can optionally be marked optional:true to skip on failure (e.g., selector not found)
export type FlowStep =
  | { action: 'goto'; url: string; optional?: boolean }
  | { action: 'click'; selector: string; label?: string; optional?: boolean }
  | { action: 'press'; selector: string; key: string; optional?: boolean }
  | { action: 'type'; selector: string; text: string; delay?: number; optional?: boolean }
  | { action: 'wait'; ms?: number; selector?: string; optional?: boolean }
  | { action: 'scroll'; y?: number; selector?: string; smooth?: boolean; optional?: boolean }
  | { action: 'sleep'; ms: number; optional?: boolean }
  | { action: 'broll'; duration: number; optional?: boolean };

export interface FlowEvent {
  t: number; // ms from start
  type: string;
  selector?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number; // normalized viewport box
}

export interface FlowDefinition {
  name?: string;
  viewport?: { width: number; height: number };
  steps: FlowStep[];
}

export interface RunFlowOptions {
  speed?: number;
}

export function loadFlow(file: string): FlowDefinition {
  const content = fs.readFileSync(file, 'utf8');
  const data = YAML.parse(content);
  if (!data.steps || !Array.isArray(data.steps))
    throw new Error('Flow YAML must have a steps array');
  return data as FlowDefinition;
}

export async function runFlow(
  page: Page,
  flow: FlowDefinition,
  opts: RunFlowOptions = {}
): Promise<FlowEvent[]> {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const SELECTOR_TIMEOUT = 10000; // prevent long 30s stalls

  await page.addInitScript(() => {
    (window as any).__ensureDemoOverlay = () => {
      if (document.getElementById('__demoCursor')) return;
      // Some bundlers / transpilers may reference a helper named __name; provide a harmless stub to avoid ReferenceError in page context.
      if (!(window as any).__name) {
        (window as any).__name = function (o: any) {
          return o;
        };
      }
      const cursor = document.createElement('div');
      cursor.id = '__demoCursor';
      Object.assign(cursor.style, {
        position: 'fixed',
        width: '20px',
        height: '20px',
        background: 'rgba(255,255,255,0.95)',
        borderRadius: '50%',
        boxShadow: '0 0 0 2px #0f172a, 0 0 10px 2px rgba(255,255,255,0.5)',
        top: '0px',
        left: '0px',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: '999999',
      });
      document.body.appendChild(cursor);
      const style = document.createElement('style');
      style.textContent = `@keyframes demoClickRipple {0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}80%{opacity:.15}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}\n.__demoHighlight {outline: 3px solid #3b82f6!important; outline-offset:2px!important; transition: outline-color .3s;}\n.__demoClickRipple {position:fixed; width:50px; height:50px; border:3px solid #38bdf8; border-radius:50%; pointer-events:none; animation:demoClickRipple .6s cubic-bezier(.4,0,.2,1) forwards; z-index:999998; mix-blend-mode:screen;}`;
      document.head.appendChild(style);
      (window as any).__demoCursorMove = (x: number, y: number, duration = 500) =>
        new Promise<void>((res) => {
          const el = cursor;
          const sx = parseFloat(el.getAttribute('data-x') || '0');
          const sy = parseFloat(el.getAttribute('data-y') || '0');
          const start = performance.now();
          function step(t: number) {
            const k = Math.min(1, (t - start) / duration);
            const ease = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
            const cx = sx + (x - sx) * ease;
            const cy = sy + (y - sy) * ease;
            el.style.transform = `translate(${cx}px, ${cy}px)`;
            el.setAttribute('data-x', String(cx));
            el.setAttribute('data-y', String(cy));
            if (k < 1) requestAnimationFrame(step);
            else res();
          }
          requestAnimationFrame(step);
        });
      (window as any).__demoScrollTo = (top: number, duration = 1000) =>
        new Promise<void>((res) => {
          const startTop = document.scrollingElement?.scrollTop || window.scrollY;
          const delta = top - startTop;
          const start = performance.now();
          function step(t: number) {
            const k = Math.min(1, (t - start) / duration);
            const ease = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
            const ct = startTop + delta * ease;
            window.scrollTo(0, ct);
            if (k < 1) requestAnimationFrame(step);
            else res();
          }
          requestAnimationFrame(step);
        });
      (window as any).__demoClickEffect = (x: number, y: number) => {
        const r = document.createElement('div');
        r.className = '__demoClickRipple';
        r.style.left = x + 'px';
        r.style.top = y + 'px';
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 650);
      };
      (window as any).__demoHighlight = (el: Element) => {
        el.classList.add('__demoHighlight');
        setTimeout(() => el.classList.remove('__demoHighlight'), 1400);
      };
      // Network + loading instrumentation (generic / arbitrary site)
      if (!(window as any).__demosnapNet) {
        (window as any).__demosnapNet = { pending: 0 };
        const net = (window as any).__demosnapNet;
        // Fetch wrapper
        const origFetch = window.fetch.bind(window);
        (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          net.pending++;
          try {
            return await origFetch(input as any, init);
          } finally {
            setTimeout(() => net.pending--, 0);
          }
        };
        // XHR wrapper
        const OrigXHR = window.XMLHttpRequest;
        (window as any).XMLHttpRequest = function () {
          const xhr = new OrigXHR();
          let done = false;
          net.pending++;
          function finalize() {
            if (!done) {
              done = true;
              setTimeout(() => net.pending--, 0);
            }
          }
          xhr.addEventListener('loadend', finalize);
          xhr.addEventListener('error', finalize);
          xhr.addEventListener('abort', finalize);
          return xhr;
        };
      }
      if (!(window as any).__demosnapLoadProbe) {
        (window as any).__demosnapLoadProbe = () => {
          function visible(el: Element) {
            const r = el.getBoundingClientRect();
            return (
              r.width > 4 &&
              r.height > 4 &&
              r.bottom > 0 &&
              r.right > 0 &&
              r.top < innerHeight &&
              r.left < innerWidth &&
              getComputedStyle(el).visibility !== 'hidden' &&
              getComputedStyle(el).display !== 'none'
            );
          }
          const selectors = [
            '[role=progressbar]',
            '[aria-busy=true]',
            '.spinner',
            '.loading',
            '.progress',
            '[data-loading]',
            '[data-testid*=loading]',
            '[class*=spinner]',
            '[class*=progress]',
            '[class*=loading]',
          ];
          const cand: HTMLElement[] = [];
          for (const sel of selectors) {
            document
              .querySelectorAll(sel)
              .forEach((e) => visible(e) && cand.push(e as HTMLElement));
          }
          // text indicators
          const textRx = /(processing|loading|uploading|saving|rendering|working)/i;
          document.querySelectorAll('body *:not(script):not(style)').forEach((e) => {
            if (cand.length < 15 && !selectors.some((s) => (e as any).matches?.(s))) {
              const t = (e.textContent || '').trim();
              if (t.length < 40 && textRx.test(t) && visible(e)) cand.push(e as HTMLElement);
            }
          });
          // pick largest non-nearly-fullscreen element
          let pick: HTMLElement | null = null;
          let bestA = 0;
          cand.forEach((el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > bestA && !(r.width > innerWidth * 0.92 && r.height > innerHeight * 0.85)) {
              bestA = a;
              pick = el;
            }
          });
          if (!pick) return null;
          const r = (pick as HTMLElement).getBoundingClientRect();
          return {
            x: (r.left + r.width / 2) / innerWidth,
            y: (r.top + r.height / 2) / innerHeight,
            w: r.width / innerWidth,
            h: r.height / innerHeight,
          };
        };
      }
    };
    document.addEventListener('DOMContentLoaded', () => (window as any).__ensureDemoOverlay());
  });

  const ensureOverlay = () =>
    page.evaluate(
      () => (window as any).__ensureDemoOverlay && (window as any).__ensureDemoOverlay()
    );

  async function moveCursorToSelector(selector: string) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout: SELECTOR_TIMEOUT });
    } catch {
      return null;
    }
    let box: any = null;
    try {
      box = await page.locator(selector).boundingBox();
    } catch (e: any) {
      if (/strict mode violation/i.test(String(e))) {
        // Fallback: pick first visible candidate among matches
        try {
          box = await page.evaluate((sel: string) => {
            const list = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            const vis = list.filter((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 4 &&
                r.height > 4 &&
                r.bottom > 0 &&
                r.right > 0 &&
                r.top < innerHeight &&
                r.left < innerWidth &&
                getComputedStyle(el).visibility !== 'hidden' &&
                getComputedStyle(el).display !== 'none'
              );
            });
            const el = vis[0] || list[0];
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          }, selector);
        } catch {}
      } else throw e;
    }
    if (!box) return null;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.evaluate(
      ({ x, y }: { x: number; y: number }) => (window as any).__demoCursorMove(x, y),
      { x: cx, y: cy }
    );
    return { cx, cy };
  }

  // Enable per-step logging inside the page for easier diagnosis
  const log = (...args: any[]) => console.log('[flow]', ...args);
  const events: FlowEvent[] = [];
  const t0 = Date.now();
  function pushEvent(ev: Omit<FlowEvent, 't'>) {
    events.push({ t: Date.now() - t0, ...ev });
  }

  async function smartLoadingWait(maxMs = 6000, minMs = 500) {
    const start = Date.now();
    let loadStarted = false;
    let lastProgressTs = 0;
    let indicatorBox: any = null;
    while (Date.now() - start < maxMs) {
      const data = await page
        .evaluate(() => ({
          net: (window as any).__demosnapNet?.pending || 0,
          box: (window as any).__demosnapLoadProbe ? (window as any).__demosnapLoadProbe() : null,
        }))
        .catch(() => ({ net: 0, box: null }));
      const elapsed = Date.now() - start;
      if (!loadStarted && data.box) {
        indicatorBox = data.box;
        loadStarted = true;
        pushEvent({
          type: 'load-start',
          x: data.box.x,
          y: data.box.y,
          w: data.box.w,
          h: data.box.h,
        });
      }
      if (loadStarted && data.box) {
        indicatorBox = data.box;
        const elapsed = Date.now() - start;
        const cadence = elapsed < 2000 ? 900 : 1400; // adaptive pacing to avoid spam
        if (Date.now() - lastProgressTs > cadence) {
          pushEvent({
            type: 'load-progress',
            x: data.box.x,
            y: data.box.y,
            w: data.box.w,
            h: data.box.h,
          });
          lastProgressTs = Date.now();
        }
      }
      // completion conditions
      if (elapsed > minMs) {
        const netQuiet = data.net === 0;
        const gone = loadStarted && !data.box; // indicator vanished
        if (netQuiet && (gone || loadStarted)) break;
      }
      await page.waitForTimeout(160);
    }
    if (loadStarted) {
      const box = indicatorBox;
      if (box) pushEvent({ type: 'load-complete', x: box.x, y: box.y, w: box.w, h: box.h });
      // Attempt result-focus region capture (largest new content container)
      try {
        const resBox = await page.evaluate(() => {
          function visible(el: Element) {
            const r = el.getBoundingClientRect();
            return (
              r.width > 30 &&
              r.height > 30 &&
              r.top >= 0 &&
              r.left >= 0 &&
              r.bottom <= innerHeight * 1.1 &&
              r.right <= innerWidth * 1.1 &&
              getComputedStyle(el).visibility !== 'hidden' &&
              getComputedStyle(el).display !== 'none'
            );
          }
          const candidates = Array.from(
            document.querySelectorAll('main,section,article,div[id],div[class]')
          ) as HTMLElement[];
          let pick: HTMLElement | null = null;
          let best = 0;
          for (const el of candidates) {
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width / innerWidth > 0.95 && r.height / innerHeight > 0.9) continue; // skip full screen
            const area = r.width * r.height;
            if (area > best) {
              best = area;
              pick = el;
            }
          }
          if (!pick) return null;
          const r = pick.getBoundingClientRect();
          return {
            x: (r.left + r.width / 2) / innerWidth,
            y: (r.top + r.height / 2) / innerHeight,
            w: r.width / innerWidth,
            h: r.height / innerHeight,
          };
        });
        if (resBox)
          pushEvent({
            type: 'result-focus',
            x: (resBox as any).x,
            y: (resBox as any).y,
            w: (resBox as any).w,
            h: (resBox as any).h,
          });
      } catch {}
    }
  }

  for (const [i, step] of flow.steps.entries()) {
    log('step', i, step.action, JSON.stringify(step));
    const exec = async () => {
      if (i === 0 && !events.some((e) => e.type === 'establish')) {
        pushEvent({ type: 'establish', x: 0.5, y: 0.5, w: 1, h: 1 });
      }
      switch (step.action) {
        case 'goto':
          await page.goto(step.url, { waitUntil: 'domcontentloaded' });
          await ensureOverlay();
          await page.evaluate(() =>
            (window as any).__demoCursorMove(window.innerWidth / 2, window.innerHeight / 2, 300)
          );
          // Reset scroll to top and emit a synthetic scroll event so camera framing knows baseline
          try {
            await page.evaluate(() => window.scrollTo(0, 0));
          } catch {}
          pushEvent({ type: 'goto', selector: step.url });
          break;
        case 'type': {
          await ensureOverlay();
          // If the selector does not resolve to a fillable element, downgrade to click
          try {
            const isFillable = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel) as any;
              if (!el) return false;
              const tag = el.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') return true;
              if (el.isContentEditable) return true;
              return false;
            }, step.selector);
            if (!isFillable) {
              // Repackage as click step
              log('downgrade type->click (non-fillable)', step.selector);
              const clickStep: any = {
                action: 'click',
                selector: (step as any).selector,
                label: (step as any).label,
              };
              // Execute click path inline (duplicate minimal logic instead of recursion)
              try {
                await page
                  .locator(clickStep.selector)
                  .scrollIntoViewIfNeeded({ timeout: 1500 })
                  .catch(() => {});
              } catch {}
              await moveCursorToSelector(clickStep.selector);
              try {
                const box = await page.locator(clickStep.selector).boundingBox();
                if (box)
                  pushEvent({
                    type: 'click',
                    selector: clickStep.selector,
                    x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                    y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                    w: box.width / (await page.viewportSize()).width,
                    h: box.height / (await page.viewportSize()).height,
                  });
              } catch {}
              await page.click(clickStep.selector).catch(() => {});
              break; // finish this step
            }
          } catch {}
          // Proactively dismiss common full-screen overlays that block interaction (world-class resilience)
          await page.evaluate(() => {
            const blockers = Array.from(
              document.querySelectorAll(
                '[data-blocking],#helpOverlay.help-overlay.open,.modal.open,.overlay.open'
              )
            ) as HTMLElement[];
            for (const b of blockers) {
              // Prefer semantic close buttons
              const closeBtn = b.querySelector('button, [role=button], .close, .btn-close');
              if (closeBtn) {
                try {
                  (closeBtn as HTMLElement).click();
                } catch {}
              }
              // Fallback: remove "open" class or hide element so it no longer intercepts pointer events
              b.classList.remove('open');
              b.style.pointerEvents = 'none';
              b.style.opacity = '0';
            }
          });
          await moveCursorToSelector(step.selector);
          // Attempt click with obstruction recovery retries
          let clicked = false;
          let lastErr: any;
          for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
            try {
              await page.click(step.selector, { delay: 40 / speed, timeout: 2000 });
              clicked = true;
            } catch (e: any) {
              lastErr = e;
              // If intercept error, attempt to dismiss again then retry
              const msg = String(e.message || '');
              if (/intercepts pointer events|not receiving pointer events|Timeout/i.test(msg)) {
                await page.evaluate(() => {
                  const hov = document.getElementById('helpOverlay');
                  if (hov && hov.classList.contains('open')) hov.classList.remove('open');
                  // Remove other fixed full-screen elements heuristically
                  const fullScreens = Array.from(
                    document.querySelectorAll('div,section')
                  ) as HTMLElement[];
                  for (const el of fullScreens) {
                    const r = el.getBoundingClientRect();
                    if (
                      r.width >= window.innerWidth * 0.9 &&
                      r.height >= window.innerHeight * 0.9 &&
                      getComputedStyle(el).position === 'fixed' &&
                      el !== document.body
                    ) {
                      if (el.id === 'helpOverlay') continue; // already handled
                      if (!el.hasAttribute('data-allow-block')) {
                        el.style.pointerEvents = 'none';
                        el.style.opacity = '0';
                      }
                    }
                  }
                });
                await page.waitForTimeout(150);
              } else {
                break;
              }
            }
          }
          if (!clicked) {
            if ((step as any).optional) {
              log('optional type step could not click', step.selector, lastErr?.message);
              break;
            }
            throw lastErr || new Error('type click failed ' + step.selector);
          }
          await page.fill(step.selector, '');
          // Prefocus event at the start of typing to allow early camera zoom-in.
          try {
            const box = await page.locator(step.selector).boundingBox();
            if (box)
              pushEvent({
                type: 'prefocus',
                selector: step.selector,
                x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                w: box.width / (await page.viewportSize()).width,
                h: box.height / (await page.viewportSize()).height,
              });
          } catch {}
          const delay = (step.delay ?? 70) / speed;
          const textToType = (step as any).text ?? '';
          // Type character by character to allow micro-event emission
          for (const ch of String(textToType).split('')) {
            await page.type(step.selector, ch, { delay });
            pushEvent({ type: 'type-char', selector: step.selector });
          }
          await page.waitForTimeout(250 / speed);
          const box = await page.locator(step.selector).boundingBox();
          if (box)
            pushEvent({
              type: 'type',
              selector: step.selector,
              x: (box.x + box.width / 2) / (await page.viewportSize()).width,
              y: (box.y + box.height / 2) / (await page.viewportSize()).height,
              w: box.width / (await page.viewportSize()).width,
              h: box.height / (await page.viewportSize()).height,
            });
          break;
        }
        case 'press': {
          await ensureOverlay();
          await moveCursorToSelector(step.selector);
          await page.focus(step.selector);
          try {
            const box = await page.locator(step.selector).boundingBox();
            if (box)
              pushEvent({
                type: 'prefocus',
                selector: step.selector,
                x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                w: box.width / (await page.viewportSize()).width,
                h: box.height / (await page.viewportSize()).height,
              });
          } catch {}
          await page.keyboard.press(step.key);
          try {
            const box = await page.locator(step.selector).boundingBox();
            if (box)
              pushEvent({
                type: 'press',
                selector: step.selector,
                x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                w: box.width / (await page.viewportSize()).width,
                h: box.height / (await page.viewportSize()).height,
              });
          } catch {}
          await page.waitForTimeout(200 / speed);
          break;
        }
        case 'click': {
          await ensureOverlay();
          // Always attempt to scroll target into center viewport for cinematic framing
          if ((step as any).selector) {
            try {
              await page.evaluate(
                (sel: string) => {
                  const el = document.querySelector(sel);
                  if (el) {
                    // Only scroll if element not already mostly within safe viewport box (15% inset)
                    const r = el.getBoundingClientRect();
                    const safeX = window.innerWidth * 0.15;
                    const safeY = window.innerHeight * 0.15;
                    const inView =
                      r.top >= safeY &&
                      r.bottom <= window.innerHeight - safeY &&
                      r.left >= safeX &&
                      r.right <= window.innerWidth - safeX;
                    if (!inView)
                      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                  }
                },
                (step as any).selector
              );
            } catch {}
          }
          // Dismiss potential blocking overlays before attempting to resolve selector
          await page.evaluate(() => {
            const hov = document.getElementById('helpOverlay');
            if (hov && hov.classList.contains('open')) {
              // Keep HUD visible but non-blocking
              hov.classList.remove('open');
            }
          });
          // Resilient selector resolution
          async function resolveSelector(raw: string): Promise<string | null> {
            const variants: string[] = [];
            const trimmed = raw.trim();
            variants.push(trimmed);
            if (/\.[^>]*\s+[A-Za-z0-9_-]/.test(trimmed)) {
              variants.push(
                trimmed.replace(/\.(\S*?)\s+(?=[A-Za-z0-9_-])/g, (m) => m.replace(/\s+/g, '.'))
              );
              variants.push(trimmed.replace(/\s+/g, '.'));
            }
            if (trimmed.includes('>')) {
              const last = trimmed.split('>').slice(-1)[0].trim();
              if (last && !variants.includes(last)) variants.push(last);
            }
            const uniq = Array.from(new Set(variants));
            for (const v of uniq) {
              try {
                await page.waitForSelector(v, { state: 'attached', timeout: 1000 });
                return v;
              } catch {}
            }
            return null;
          }
          const resolved = await resolveSelector(step.selector);
          const targetSel = resolved || step.selector;
          if (resolved && resolved !== step.selector) {
            log('selector variant chosen', step.selector, '=>', resolved);
          }
          let finalSel = targetSel;
          // Label-based fallback: search clickable elements containing label text
          if (!resolved && step.label) {
            const labelText = step.label.trim();
            if (labelText.length > 1) {
              try {
                const found = await page.evaluate((text: string) => {
                  const candidates = Array.from(
                    document.querySelectorAll('a,button,[role="button"],input[type=submit]')
                  ) as HTMLElement[];
                  const lower = text.toLowerCase();
                  const el = candidates.find(
                    (c) =>
                      (c.innerText || c.textContent || '').trim().toLowerCase() === lower ||
                      (c.innerText || c.textContent || '').trim().toLowerCase().includes(lower)
                  );
                  if (!el) return null;
                  // Build a simple selector path
                  function simple(el: Element): string {
                    if (!el || !el.parentElement) return el.tagName.toLowerCase();
                    const id = el.id ? '#' + el.id : '';
                    const cls = el.classList.length
                      ? '.' + Array.from(el.classList).slice(0, 3).join('.')
                      : '';
                    return simple(el.parentElement) + '>' + el.tagName.toLowerCase() + id + cls;
                  }
                  return simple(el).replace(/^html>body>/, '');
                }, labelText);
                if (found) {
                  log('label fallback selector', labelText, '=>', found);
                  finalSel = found;
                }
              } catch {}
            }
          }
          const pos = await moveCursorToSelector(finalSel);
          if (pos) {
            try {
              const box = await page.locator(finalSel).boundingBox();
              if (box)
                pushEvent({
                  type: 'prefocus',
                  selector: finalSel,
                  x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                  y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                  w: box.width / (await page.viewportSize()).width,
                  h: box.height / (await page.viewportSize()).height,
                });
            } catch {}
            await page.evaluate(
              ({ sel, x, y }: { sel: string; x: number; y: number }) => {
                const el = document.querySelector(sel);
                if (el) {
                  (window as any).__demoHighlight(el);
                  (window as any).__demoClickEffect(x, y);
                }
              },
              { sel: finalSel, x: pos.cx, y: pos.cy }
            );
            try {
              const box = await page.locator(finalSel).boundingBox();
              if (box)
                pushEvent({
                  type: 'click',
                  selector: finalSel,
                  x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                  y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                  w: box.width / (await page.viewportSize()).width,
                  h: box.height / (await page.viewportSize()).height,
                });
            } catch {}
            // Click with obstruction recovery (same strategy as type)
            let clicked = false;
            let lastErr: any;
            for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
              try {
                await page.click(finalSel, { delay: 40 / speed, timeout: 2000 });
                clicked = true;
              } catch (e: any) {
                lastErr = e;
                const msg = String(e.message || '');
                if (/intercepts pointer events|not receiving pointer events|Timeout/i.test(msg)) {
                  await page.evaluate(() => {
                    const hov = document.getElementById('helpOverlay');
                    if (hov && hov.classList.contains('open')) hov.classList.remove('open');
                  });
                  await page.waitForTimeout(120);
                } else break;
              }
            }
            if (!clicked) {
              if ((step as any).optional)
                log('optional click could not execute after retries', finalSel, lastErr?.message);
              else throw lastErr || new Error('click failed ' + finalSel);
            }
            await page.waitForTimeout(120 / speed);
            // Post click focus (after potential navigation/content shift)
            try {
              await page.waitForTimeout(180 / speed);
              const box = await page.locator(finalSel).boundingBox();
              if (box)
                pushEvent({
                  type: 'postclick',
                  selector: finalSel,
                  x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                  y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                  w: box.width / (await page.viewportSize()).width,
                  h: box.height / (await page.viewportSize()).height,
                });
            } catch {}
          } else {
            if (!(step as any).optional)
              throw new Error('click selector not found ' + step.selector);
          }
          break;
        }
        case 'wait': {
          if (step.selector) {
            try {
              await page.waitForSelector(step.selector, {
                state: 'visible',
                timeout: step.ms ?? 2000,
              });
            } catch {
              if ((step as any).optional) {
                log('optional wait timeout', step.selector);
                break;
              } else throw new Error('wait selector timeout ' + step.selector);
            }
          } else {
            await page.waitForTimeout((step.ms ?? 1000) / speed);
          }
          pushEvent({ type: 'wait', selector: (step as any).selector });
          break;
        }
        case 'scroll': {
          await ensureOverlay();
          if (step.selector) {
            try {
              await page.locator(step.selector).scrollIntoViewIfNeeded();
            } catch {}
            // Center element for consistent framing
            try {
              await page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
              }, step.selector);
            } catch {}
            await moveCursorToSelector(step.selector);
            try {
              const box = await page.locator(step.selector).boundingBox();
              if (box)
                pushEvent({
                  type: 'scroll',
                  selector: step.selector,
                  x: (box.x + box.width / 2) / (await page.viewportSize()).width,
                  y: (box.y + box.height / 2) / (await page.viewportSize()).height,
                  w: box.width / (await page.viewportSize()).width,
                  h: box.height / (await page.viewportSize()).height,
                });
            } catch {}
          } else {
            const targetY =
              (step as any).y ??
              (await page.evaluate(() => document.body.scrollHeight - window.innerHeight));
            if ((step as any).smooth)
              await page.evaluate(
                ({ y, d }: { y: number; d: number }) => (window as any).__demoScrollTo(y, d),
                { y: targetY, d: 1000 / speed }
              );
            else
              await page.evaluate(({ y }: { y: number }) => window.scrollTo(0, y), { y: targetY });
            pushEvent({ type: 'scroll' });
          }
          await page.waitForTimeout(250 / speed);
          break;
        }
        case 'sleep':
          await page.waitForTimeout(step.ms / speed);
          pushEvent({ type: 'sleep' });
          break;
        case 'broll':
          // Adaptive: if recent action and potential loading, perform smart loading wait instead of passive broll
          const prevAction = [...events]
            .reverse()
            .find((ev) => ['click', 'type', 'press', 'postclick'].includes(ev.type));
          if (prevAction) {
            // Probe quickly whether a loading indicator likely to appear (network pending or indicator soon)
            let didSmart = false;
            try {
              const early = await page.evaluate(() => ({
                net: (window as any).__demosnapNet?.pending || 0,
                box: (window as any).__demosnapLoadProbe
                  ? (window as any).__demosnapLoadProbe()
                  : null,
              }));
              if (early.net > 0 || early.box) {
                await smartLoadingWait(Math.min(6000, step.duration * 3));
                didSmart = true;
              }
            } catch {}
            if (!didSmart) {
              // fallback original behavior (focus previous element)
              pushEvent({
                type: 'broll-focus',
                x: prevAction.x,
                y: prevAction.y,
                w: prevAction.w,
                h: prevAction.h,
              });
              await page.waitForTimeout(step.duration / speed);
              pushEvent({ type: 'broll' });
            }
          } else {
            await page.waitForTimeout(step.duration / speed);
            pushEvent({ type: 'broll' });
          }
          break;
        default:
          throw new Error(`Unknown step action at index ${i}`);
      }
    };
    try {
      await exec();
    } catch (err) {
      if ((step as any).optional) {
        log('optional step failed, skipping', i, step.action, (err as Error).message);
      } else throw err;
    }
  }
  return events;
}
