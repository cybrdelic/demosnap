import fs from 'node:fs';
import * as playwright from 'playwright';

export interface AutoFlowCandidate {
  selector: string;
  label: string;
  area: number; // px^2
  tag: string;
  score: number;
  variants: string[];
  cx?: number; // normalized center x (0..1)
  cy?: number; // normalized center y (0..1)
  pass?: string; // which discovery pass produced it
}

export interface AutoFlowResult {
  yaml: string;
  candidates: AutoFlowCandidate[];
  chosen: AutoFlowCandidate[];
}

export interface AutoFlowProgressEvent {
  stage: string;
  message?: string;
  data?: any;
}

interface GenerateOptions {
  url: string;
  maxActions?: number;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  debug?: boolean;
  onProgress?: (ev: AutoFlowProgressEvent) => void;
}

const VISIBLE_STYLE_PROPS = ['display', 'visibility', 'opacity'];

function buildSelectorVariants(el: any): string[] {
  const variants: string[] = [];
  if (el.id) variants.push('#' + CSS.escape(el.id));
  const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean);
  if (cls.length)
    variants.push(el.tagName.toLowerCase() + '.' + cls.map((c: string) => CSS.escape(c)).join('.'));
  if (el.getAttribute) {
    const dataTest =
      el.getAttribute('data-testid') ||
      el.getAttribute('data-test') ||
      el.getAttribute('aria-label');
    if (dataTest) variants.push(`[aria-label="${dataTest}"]`);
  }
  const text = (el.innerText || '').trim();
  if (text && text.length < 40)
    variants.push(`${el.tagName.toLowerCase()}:has-text("${text.replace(/"/g, '\\"')}")`);
  return Array.from(new Set(variants)).slice(0, 5);
}

export async function generateAutoFlow(opts: GenerateOptions): Promise<AutoFlowResult> {
  const progress = (stage: string, message?: string, data?: any) => {
    try {
      opts.onProgress && opts.onProgress({ stage, message, data });
    } catch {}
  };
  progress('launch', 'Launching browser');
  const browser = await (playwright as any).chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: opts.viewport?.width || 1280, height: opts.viewport?.height || 720 },
  });
  // Inject __name stub early to avoid ReferenceError from pages that assume bundler helper
  await context.addInitScript(() => {
    if (!(window as any).__name) {
      (window as any).__name = function (o: any) {
        return o;
      };
    }
  });
  const page = await context.newPage();
  progress('navigate', 'Navigating to URL', { url: opts.url });
  await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
  progress('settle', 'Settling');
  await page.waitForTimeout(800);

  // --- Helper: collect ONLY meaningful interactive candidates ---
  async function collect(pass: string) {
    const res = await page.evaluate((passLabel: string) => {
      const list: any[] = [];

      // Target only truly interactive elements
      const interactiveSelectors = [
        'button:not([disabled])',
        'a[href]:not([href="#"]):not([href=""])',
        'input[type="button"]:not([disabled])',
        'input[type="submit"]:not([disabled])',
        'input[type="text"]:not([disabled])',
        'input[type="search"]:not([disabled])',
        'input[type="email"]:not([disabled])',
        'input[type="password"]:not([disabled])',
        'textarea:not([disabled])',
        '[role="button"]:not([aria-disabled="true"])',
        '[role="link"]:not([aria-disabled="true"])',
      ];

      const elements = Array.from(
        document.querySelectorAll(interactiveSelectors.join(','))
      ) as HTMLElement[];

      function isVisible(el: HTMLElement): boolean {
        const style = getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') < 0.1
        ) {
          return false;
        }

        const rect = el.getBoundingClientRect();
        // Must be reasonably sized and on screen
        if (rect.width < 20 || rect.height < 20) return false;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)
          return false;

        return true;
      }

      function getActionLabel(el: HTMLElement): string {
        // Priority order for getting meaningful labels
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim().length > 0) return ariaLabel.trim();

        const title = el.getAttribute('title');
        if (title && title.trim().length > 0) return title.trim();

        // For form inputs, use placeholder or label
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) return placeholder;

          const labelFor = document.querySelector(`label[for="${el.id}"]`);
          if (labelFor) return labelFor.textContent?.trim() || '';

          return `${el.tagName.toLowerCase()} field`;
        }

        // For buttons and links, get text content but be selective
        let text = el.textContent?.trim() || '';

        // Skip if text is too long (likely container) or too short (icon/empty)
        if (text.length > 100 || text.length < 1) return '';

        // Skip generic/meaningless text
        const genericPatterns =
          /^(here|click|link|button|div|span|text|content|\\s*|\\d+|\\.|\\,|\\:|\\;)$/i;
        if (genericPatterns.test(text)) return '';

        // Take first sentence or limit words
        text = text.split(/[.!?]/)[0] || text;
        const words = text.split(/\\s+/).slice(0, 8).join(' ');

        return words.length > 60 ? words.slice(0, 57) + '…' : words;
      }

      elements.forEach((el) => {
        if (!isVisible(el)) return;

        const label = getActionLabel(el);
        if (!label) return; // Skip elements without meaningful labels

        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const area = Math.round(rect.width * rect.height);
        const cx = (rect.x + rect.width / 2) / innerWidth;
        const cy = (rect.y + rect.height / 2) / innerHeight;

        // Build better selector
        const pathBits: string[] = [];
        let cur: any = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && depth < 4) {
          let seg = cur.tagName.toLowerCase();
          if (cur.id) {
            seg += '#' + cur.id;
            pathBits.unshift(seg);
            break;
          }
          const cls = (cur.className || '')
            .toString()
            .trim()
            .split(/\\s+/)
            .filter(Boolean)
            .slice(0, 2);
          if (cls.length) seg += '.' + cls.join('.');
          pathBits.unshift(seg);
          cur = cur.parentElement;
          depth++;
        }
        const simplePath = pathBits.join('>');

        list.push({
          tag,
          label,
          area,
          simplePath,
          cx,
          cy,
          pass: passLabel,
          actionType: getActionType(el),
        });
      });

      function getActionType(el: HTMLElement): string {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const label = el.textContent?.toLowerCase() || '';

        if (tag === 'input') {
          if (['text', 'search', 'email', 'password'].includes(type || '')) return 'type';
          if (['submit', 'button'].includes(type || '')) return 'click';
        }

        if (tag === 'textarea') return 'type';
        if (tag === 'a') return 'click';

        if (tag === 'button' || el.getAttribute('role') === 'button') {
          if (/submit|send|post|save/i.test(label)) return 'submit';
          return 'click';
        }

        return 'click';
      }

      return list;
    }, pass);

    progress('collect_pass', 'Collected pass', { pass: pass, count: res.length });
    return res as any[];
  }

  progress('collect', 'Collecting interactive candidates (multi-pass)');
  const passInitial = await collect('initial');
  // Attempt reveal: click a likely CTA (Sign In, Get Started, Login, Search) without navigation
  try {
    const revealTarget = passInitial.find((c) => /sign|get|log|search/i.test(c.label));
    if (revealTarget) {
      progress('reveal_click', 'Attempting reveal click', { label: revealTarget.label });
      await page
        .locator(':text("' + revealTarget.label.replace(/"/g, '\\"') + '")')
        .first()
        .click({ timeout: 1200 });
      await page.waitForTimeout(400);
    }
  } catch {}
  const passAfterReveal = await collect('afterReveal');
  // Scroll passes
  const scrollHeights = [0.45, 0.85];
  const scrollPasses: any[] = [];
  for (let i = 0; i < scrollHeights.length; i++) {
    try {
      const h = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
      const target = Math.max(0, Math.min(h, Math.round(h * scrollHeights[i])));
      await page.evaluate((y: number) => window.scrollTo(0, y), target);
      await page.waitForTimeout(500);
      scrollPasses.push(...(await collect('scroll' + i)));
    } catch {}
  }
  const raw = [...passInitial, ...passAfterReveal, ...scrollPasses];
  progress('collected', 'Raw candidates collected', {
    count: raw.length,
    passes: {
      initial: passInitial.length,
      afterReveal: passAfterReveal.length,
      scroll: scrollPasses.length,
    },
  });
  const MAX_CANDIDATES = 140;
  const truncated = raw.slice(0, MAX_CANDIDATES);
  // Ranking: area (normalized), label weight (action verbs), centrality bias
  const width = (await page.viewportSize()).width;
  const height = (await page.viewportSize()).height;
  const scored: AutoFlowCandidate[] = [];

  for (const r of truncated) {
    // Skip if no meaningful label
    if (!r.label || r.label.length < 2) continue;

    // Action word bonus for meaningful CTAs
    const actionWords =
      /sign|start|learn|try|search|create|get|explore|watch|play|login|log in|sign in|submit|send|buy|purchase|download|register|join|contact|book|reserve|order|add|remove|delete|edit|save|cancel|continue|next|previous|back|home|menu|close|open/i;
    const labelWeight = actionWords.test(r.label) ? 1.6 : 1.0;

    // Size scoring - prefer medium-sized elements
    const areaRatio = r.area / (width * height);
    let areaScore = 0;

    if (areaRatio > 0.4)
      areaScore = 0.1; // Too big, likely container
    else if (areaRatio > 0.15)
      areaScore = 0.3; // Still quite large
    else if (areaRatio > 0.05)
      areaScore = 1.0; // Good size
    else if (areaRatio > 0.01)
      areaScore = 0.8; // Reasonable
    else areaScore = 0.2; // Very small

    // Position scoring - slight center bias
    const centerDistance = Math.hypot(r.cx - 0.5, r.cy - 0.5);
    const positionScore = 1 - centerDistance * 0.3;

    // Action type bonus
    let typeBonus = 1.0;
    if (r.actionType === 'submit') typeBonus = 1.4;
    else if (r.actionType === 'type') typeBonus = 1.2;

    const finalScore =
      0.4 * areaScore + 0.35 * labelWeight + 0.15 * positionScore + 0.1 * typeBonus;

    // Only include if score is reasonable
    if (finalScore > 0.3) {
      scored.push({
        selector: r.simplePath,
        label: r.label,
        area: r.area,
        tag: r.tag,
        score: finalScore,
        variants: [],
        cx: r.cx,
        cy: r.cy,
        pass: r.pass,
      });
    }
  }
  // Deduplicate by label to keep diversity
  const byLabel = new Map<string, AutoFlowCandidate>();
  for (const c of scored.sort((a, b) => b.score - a.score)) {
    if (!byLabel.has(c.label.toLowerCase())) byLabel.set(c.label.toLowerCase(), c);
  }
  const unique = Array.from(byLabel.values());
  // Diversity adjustment: penalize items that share initial words with already higher-scoring labels (rough proxy for repetition)
  const seenRoots = new Set<string>();
  for (const c of unique.sort((a, b) => b.score - a.score)) {
    const root = c.label.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    if (seenRoots.has(root)) {
      c.score *= 0.78; // soft penalty
    } else {
      seenRoots.add(root);
    }
  }
  // Re-sort after penalties
  unique.sort((a, b) => b.score - a.score);
  // Spatial diversity selection: iterate sorted list and pick those not too close to existing centers
  const maxActions = opts.maxActions || 7;
  const chosen: AutoFlowCandidate[] = [];
  const DIST_MIN = 0.12; // normalized center distance threshold
  for (const cand of unique) {
    if (chosen.length >= maxActions) break;
    if (cand.cx != null && cand.cy != null) {
      const cCx = cand.cx,
        cCy = cand.cy;
      const tooClose = chosen.some(
        (c) => c.cx != null && c.cy != null && Math.hypot(c.cx - cCx, c.cy - cCy) < DIST_MIN
      );
      if (tooClose) continue; // enforce spatial spread
    }
    chosen.push(cand);
  }
  // If we under-filled, top-up with remaining highest scoring regardless of distance
  if (chosen.length < maxActions) {
    for (const cand of unique) {
      if (chosen.length >= maxActions) break;
      if (!chosen.includes(cand)) chosen.push(cand);
    }
  }
  // Final trim
  chosen.splice(maxActions);
  // If first choice still an oversized container, attempt swap with smaller one
  const BIG_RATIO = 0.3;
  if (chosen.length) {
    const first = chosen[0];
    if (first.area / (width * height) > BIG_RATIO) {
      const swap = chosen.find((c) => c.area / (width * height) < BIG_RATIO * 0.85);
      if (swap) {
        const idx = chosen.indexOf(swap);
        chosen[idx] = first;
        chosen[0] = swap;
      }
    }
  }
  progress('scored', 'Scored & selected candidates', {
    total: scored.length,
    unique: unique.length,
    chosen: chosen.length,
  });

  // Enrich chosen with better selector variants (page-side sampling)
  progress('enrich', 'Enriching selector variants');
  for (const ch of chosen) {
    try {
      const variants = await page.evaluate((simplePath: string) => {
        const segs = simplePath.split('>');
        let el: Element | null = document.querySelector(segs[segs.length - 1].replace(/#.+/, ''));
        // naive: fallback to scanning all and matching label maybe
        const candidates = Array.from(document.querySelectorAll('*')).filter(
          (e) => (e as any).innerText && (e as any).innerText.trim().startsWith('')
        );
        // We'll just gather variants from first matching text element
        if (!el && candidates.length) el = candidates[0];
        if (!el) return [] as string[];
        const v: string[] = [];
        if ((el as HTMLElement).id) v.push('#' + (el as HTMLElement).id);
        const cls =
          (el as HTMLElement).className?.toString().trim().split(/\s+/).filter(Boolean) || [];
        if (cls.length) v.push(el.tagName.toLowerCase() + '.' + cls.slice(0, 3).join('.'));

        // For links, add href-based selectors for specificity
        if (el.tagName.toLowerCase() === 'a') {
          const href = (el as HTMLAnchorElement).href;
          if (href) {
            // Add selector based on href content to distinguish links
            if (href.includes('cover.png')) v.push('a[href*="cover.png"]');
            else if (href.includes('.webm')) v.push('a[href*=".webm"]');
            else if (href.includes('.mp4')) v.push('a[href*=".mp4"]');
            else if (href.startsWith('http')) v.push(`a[href^="${new URL(href).origin}"]`);
          }
        }

        const txt = (el as HTMLElement).innerText?.trim();
        if (txt && txt.length < 40)
          v.push(el.tagName.toLowerCase() + ':has-text("' + txt.replace(/"/g, '\\"') + '")');
        return Array.from(new Set(v)).slice(0, 5);
      }, ch.selector);
      ch.variants = variants;
      progress('variant', 'Variants collected', { selector: ch.selector, variants });
    } catch {}
  }
  progress('enriched', 'Variant enrichment complete');

  await browser.close();

  // Build YAML flow
  const lines: string[] = [];
  lines.push('name: Auto Generated Flow');
  lines.push('viewport:');
  lines.push('  width: ' + (opts.viewport?.width || 1280));
  lines.push('  height: ' + (opts.viewport?.height || 720));
  lines.push('steps:');
  lines.push(`  - action: goto\n    url: ${JSON.stringify(opts.url)}`);
  let spatialVarietyScore = 0;
  for (let i = 0; i < chosen.length; i++) {
    const ch = chosen[i];
    const sel = ch.variants[0] || ch.selector.split('>').slice(-1)[0];
    const meta = `# label=${ch.label} score=${ch.score.toFixed(2)} pass=${ch.pass}`;
    if (/search/i.test(ch.label) || ch.tag === 'input') {
      lines.push(
        `  - action: type\n    selector: ${JSON.stringify(sel)} ${meta}\n    text: "demo"`
      );
      lines.push('  - action: broll\n    duration: 900');
    } else {
      lines.push(`  - action: click\n    selector: ${JSON.stringify(sel)} ${meta}`);
      lines.push('  - action: broll\n    duration: 1100');
    }
    const tier = ch.area > width * height * 0.18 ? 2 : ch.area > width * height * 0.06 ? 1 : 0;
    if (i > 0) {
      const prev = chosen[i - 1];
      const prevTier =
        prev.area > width * height * 0.18 ? 2 : prev.area > width * height * 0.06 ? 1 : 0;
      if (prevTier !== tier) spatialVarietyScore++;
    }
  }
  // Inject variety actions if variety is too low
  if (spatialVarietyScore < Math.max(1, Math.floor(chosen.length / 2))) {
    lines.push('  - action: scroll\n    target: down\n    amount: 600');
    lines.push('  - action: broll\n    duration: 1400');
  }
  const yaml = lines.join('\n');
  progress('yaml', 'YAML flow assembled', { length: yaml.length });
  progress('done', 'Auto flow generation complete');
  return { yaml, candidates: scored, chosen };
}

// CLI standalone (optional)
if (process.argv[1] && /auto-flow\.(ts|js)$/.test(process.argv[1])) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: tsx src/auto-flow.ts <url> [maxActions]');
    process.exit(1);
  }
  const max = parseInt(process.argv[3] || '5', 10);
  generateAutoFlow({ url, maxActions: max })
    .then((r) => {
      fs.writeFileSync('generated.yml', r.yaml, 'utf8');
      console.log('generated.yml written. Actions:', r.chosen.length);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
