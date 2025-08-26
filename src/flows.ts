import fs from 'node:fs';
import YAML from 'yaml';
// Fallback: explicit any for Page to avoid type resolution issues
type Page = any;

export type FlowStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'type'; selector: string; text: string; delay?: number }
  | { action: 'wait'; ms?: number; selector?: string }
  | { action: 'scroll'; y?: number; selector?: string; smooth?: boolean }
  | { action: 'sleep'; ms: number }
  | { action: 'broll'; duration: number };

export interface FlowDefinition {
  name?: string;
  viewport?: { width: number; height: number };
  steps: FlowStep[];
}

export interface RunFlowOptions { speed?: number }

export function loadFlow(file: string): FlowDefinition {
  const content = fs.readFileSync(file, 'utf8');
  const data = YAML.parse(content);
  if (!data.steps || !Array.isArray(data.steps)) throw new Error('Flow YAML must have a steps array');
  return data as FlowDefinition;
}

export async function runFlow(page: Page, flow: FlowDefinition, opts: RunFlowOptions = {}) {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;

  await page.addInitScript(() => {
    (window as any).__ensureDemoOverlay = () => {
      if (document.getElementById('__demoCursor')) return;
      const cursor = document.createElement('div');
      cursor.id = '__demoCursor';
      Object.assign(cursor.style, {
        position: 'fixed', width: '20px', height: '20px', background: 'rgba(255,255,255,0.95)',
        borderRadius: '50%', boxShadow: '0 0 0 2px #0f172a, 0 0 10px 2px rgba(255,255,255,0.5)',
        top: '0px', left: '0px', transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: '999999'
      });
      document.body.appendChild(cursor);
      const style = document.createElement('style');
      style.textContent = `@keyframes demoClickRipple {0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}80%{opacity:.15}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}\n.__demoHighlight {outline: 3px solid #3b82f6!important; outline-offset:2px!important; transition: outline-color .3s;}\n.__demoClickRipple {position:fixed; width:50px; height:50px; border:3px solid #38bdf8; border-radius:50%; pointer-events:none; animation:demoClickRipple .6s cubic-bezier(.4,0,.2,1) forwards; z-index:999998; mix-blend-mode:screen;}`;
      document.head.appendChild(style);
      (window as any).__demoCursorMove = (x: number, y: number, duration = 500) => new Promise<void>(res => {
        const el = cursor; const sx = parseFloat(el.getAttribute('data-x')||'0'); const sy = parseFloat(el.getAttribute('data-y')||'0'); const start = performance.now();
        function step(t:number){ const k = Math.min(1,(t-start)/duration); const ease = k<0.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2; const cx = sx + (x-sx)*ease; const cy = sy + (y-sy)*ease; el.style.transform = `translate(${cx}px, ${cy}px)`; el.setAttribute('data-x', String(cx)); el.setAttribute('data-y', String(cy)); if(k<1) requestAnimationFrame(step); else res(); }
        requestAnimationFrame(step);
      });
      (window as any).__demoScrollTo = (top: number, duration = 1000) => new Promise<void>(res => {
        const startTop = document.scrollingElement?.scrollTop || window.scrollY; const delta = top - startTop; const start = performance.now();
        function step(t:number){ const k = Math.min(1,(t-start)/duration); const ease = k<0.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2; const ct = startTop + delta*ease; window.scrollTo(0, ct); if(k<1) requestAnimationFrame(step); else res(); }
        requestAnimationFrame(step);
      });
      (window as any).__demoClickEffect = (x:number,y:number) => { const r = document.createElement('div'); r.className='__demoClickRipple'; r.style.left = x+'px'; r.style.top = y+'px'; document.body.appendChild(r); setTimeout(()=>r.remove(),650); };
      (window as any).__demoHighlight = (el:Element) => { el.classList.add('__demoHighlight'); setTimeout(()=>el.classList.remove('__demoHighlight'), 1400); };
    };
    document.addEventListener('DOMContentLoaded', () => (window as any).__ensureDemoOverlay());
  });

  const ensureOverlay = () => page.evaluate(() => (window as any).__ensureDemoOverlay && (window as any).__ensureDemoOverlay());

  async function moveCursorToSelector(selector: string) {
    await page.waitForSelector(selector, { state: 'visible' });
    const box = await page.locator(selector).boundingBox(); if (!box) return;
    const cx = box.x + box.width/2; const cy = box.y + box.height/2;
  await page.evaluate(({x,y}: {x:number;y:number}) => (window as any).__demoCursorMove(x, y), { x: cx, y: cy });
    return { cx, cy };
  }

  for (const [i, step] of flow.steps.entries()) {
    switch (step.action) {
      case 'goto':
        await page.goto(step.url, { waitUntil: 'domcontentloaded' });
        await ensureOverlay();
        await page.evaluate(() => (window as any).__demoCursorMove(window.innerWidth/2, window.innerHeight/2, 300));
        break;
      case 'click': {
        await ensureOverlay();
        const pos = await moveCursorToSelector(step.selector);
        if (pos) {
          await page.evaluate(({sel,x,y}: {sel:string;x:number;y:number}) => { const el = document.querySelector(sel); if (el) (window as any).__demoHighlight(el); (window as any).__demoClickEffect(x,y); }, { sel: step.selector, x: pos.cx, y: pos.cy });
        }
        await page.click(step.selector, { delay: 40 / speed });
        await page.waitForTimeout(250 / speed);
        break; }
      case 'type': {
        await ensureOverlay();
        await moveCursorToSelector(step.selector);
        await page.click(step.selector, { delay: 40 / speed });
        await page.fill(step.selector, '');
        const delay = (step.delay ?? 70) / speed;
        await page.type(step.selector, step.text, { delay });
        await page.waitForTimeout(250 / speed);
        break; }
      case 'wait':
        if (step.selector) await page.waitForSelector(step.selector); else await page.waitForTimeout((step.ms ?? 1000)/speed);
        break;
      case 'scroll': {
        await ensureOverlay();
        if (step.selector) {
          await page.locator(step.selector).scrollIntoViewIfNeeded();
          await moveCursorToSelector(step.selector);
        } else {
          const targetY = step.y ?? await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
          if (step.smooth) await page.evaluate(({y,d}: {y:number;d:number})=>(window as any).__demoScrollTo(y,d), { y: targetY, d: 1000/speed });
          else await page.evaluate(({y}: {y:number})=>window.scrollTo(0,y), { y: targetY });
        }
        await page.waitForTimeout(250 / speed);
        break; }
      case 'sleep':
        await page.waitForTimeout(step.ms / speed); break;
      case 'broll':
        await page.waitForTimeout(step.duration / speed); break;
      default:
        throw new Error(`Unknown step action at index ${i}`);
    }
  }
}
