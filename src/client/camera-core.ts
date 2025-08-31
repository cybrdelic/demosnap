// TypeScript port of camera-core.js
export interface TimelineEvent { t:number; type:string; x?:number; y?:number; w?:number; h?:number; }
export interface CamKey { t:number; cx:number; cy:number; zoom:number; cut:boolean; }
export interface CamConfig { leadMs:number; clusterMs:number; maxZoom:number; posLerp:number; zoomLerp:number; movementDeadZone:number; exposureCut:number; exposureLerp:number; settleSeconds:number; idleDriftAmp:number; idlePushInZ:number; dedupeDist:number; dedupeZoomDelta:number; cutMoveThreshold:number; cutZoomThreshold:number; }

export function buildCamConfig(style: string): CamConfig {
  const CAM: CamConfig = {
    leadMs: 900,
    clusterMs: 600,
    maxZoom: 3.2,
    posLerp: 0.065,
    zoomLerp: 0.07,
    movementDeadZone: 0.018,
    exposureCut: 1.08,
    exposureLerp: 0.06,
    settleSeconds: 8,
    idleDriftAmp: 5,
    idlePushInZ: 10,
    dedupeDist: 0.022,
    dedupeZoomDelta: 0.18,
    cutMoveThreshold: 0.06,
    cutZoomThreshold: 0.28,
  };
  if (style === 'aggressive') {
    CAM.clusterMs = 160;
    CAM.maxZoom = 4.1;
    CAM.idleDriftAmp = 2.2;
    CAM.posLerp = 0.22;
    CAM.zoomLerp = 0.18;
  } else if (style === 'cinematic') {
    // Smoother, fewer cuts, lower max zoom, longer lead-in
    CAM.leadMs = 1400;
    CAM.clusterMs = 950;
    CAM.maxZoom = 2.9;
    CAM.posLerp = 0.045;
    CAM.zoomLerp = 0.05;
    CAM.idleDriftAmp = 3.2;
    CAM.cutMoveThreshold = 0.09; // need larger move to justify a cut
    CAM.cutZoomThreshold = 0.34;
    CAM.dedupeDist = 0.018; // tighten dedupe to remove micro wiggles
  }
  return CAM;
}

export function buildCamKeys(timeline: TimelineEvent[], style: string, CAM: CamConfig): CamKey[] {
  // 1. Pre-filter: prune overly chatty load-progress events (semantic noise reduction)
  const filtered: TimelineEvent[] = [];
  let lastProgressT = -Infinity;
  const LOAD_PROGRESS_MIN_GAP = 450; // ms between accepted load-progress events
  for (const ev of timeline) {
    if (ev.type === 'load-progress') {
      if (ev.t - lastProgressT < LOAD_PROGRESS_MIN_GAP) continue;
      lastProgressT = ev.t;
    }
    filtered.push(ev);
  }

  const keys: CamKey[] = [];
  let shotIndex = 0;
  let lastCutT = -Infinity;
  for (const ev of filtered) {
    if (ev.x == null || ev.y == null) continue;
    // 2. Semantic zoom intents
    let z = 1.25;
    if (style === 'cinematic') {
      switch (ev.type) {
        case 'establish':
          z = 1.15;
          break; // wide establishing
        case 'load-start':
          z = 1.24;
          break;
        case 'load-progress':
          z = 1.26;
          break;
        case 'load-complete':
          z = 1.32;
          break;
        case 'result-focus':
          z = 1.48;
          break;
        case 'prefocus':
          z = 1.32;
          break;
        case 'click':
          z = 1.5;
          break;
        case 'type':
          z = 1.45;
          break;
        case 'press':
          z = 1.55;
          break;
        case 'wait':
          z = 1.28;
          break;
        case 'broll-focus':
          z = 1.26;
          break;
        case 'postclick':
          z = 1.48;
          break;
      }
    } else {
      switch (ev.type) {
        case 'establish':
          z = 1.12;
          break;
        case 'load-start':
          z = 1.22;
          break;
        case 'load-progress':
          z = 1.25;
          break;
        case 'load-complete':
          z = 1.3;
          break;
        case 'result-focus':
          z = 1.55;
          break;
        case 'prefocus':
          z = 1.35;
          break;
        case 'click':
          z = 1.7;
          break;
        case 'type':
          z = 1.52;
          break;
        case 'press':
          z = 1.85;
          break;
        case 'wait':
          z = 1.4;
          break;
      }
    }
    if (style === 'aggressive') {
      if (ev.type === 'click') z += 0.55;
      else if (ev.type === 'type') z += 0.45;
      else if (ev.type === 'press') z += 0.65;
    }
    // 3. Responsive zoom scaling for small focus boxes (smaller area -> deeper zoom)
    if (ev.w && ev.h) {
      const area = ev.w * ev.h; // assuming normalized [0..1]
      z *= Math.min(2.8, 1 + (0.25 - Math.min(0.25, area)) * 3.8);
    }
    z = Math.min(z, CAM.maxZoom);

    // 4. Cut logic
    let cut = style === 'aggressive' ? ev.type !== 'prefocus' : ev.type === 'click';
    if (style === 'cinematic') {
      const actionable = ev.type === 'click' || ev.type === 'result-focus' || ev.type === 'press';
      const MIN_CUT_GAP = CAM.clusterMs * 2.1; // enforce spacing between cuts
      if (actionable && ev.t - lastCutT > MIN_CUT_GAP) {
        // Avoid cutting on purely loading semantics
        cut = true;
      } else {
        cut = false;
      }
      if (ev.type === 'establish') cut = false; // establishing is a gentle move-in
      if (cut) lastCutT = ev.t;
    }

    // 5. Framing / rule-of-thirds bias (skip establishing for classic centered opener)
    let cx = ev.x,
      cy = ev.y;
    if (style === 'cinematic' && ev.type !== 'establish') {
      const biasX = shotIndex % 2 === 0 ? -0.07 : 0.07;
      const biasY = shotIndex % 3 === 0 ? -0.05 : 0.04;
      cx = Math.min(0.85, Math.max(0.15, cx + biasX));
      cy = Math.min(0.85, Math.max(0.15, cy + biasY));
    }
    keys.push({ t: ev.t, cx, cy, zoom: z, cut });
    shotIndex++;
  }
  keys.sort((a, b) => a.t - b.t);
  const clustered: CamKey[] = [];
  for (const k of keys) {
    const prev = clustered[clustered.length - 1];
    if (prev && k.t - prev.t < CAM.clusterMs) {
      prev.cx = (prev.cx + k.cx) / 2;
      prev.cy = (prev.cy + k.cy) / 2;
      prev.zoom = Math.max(prev.zoom, k.zoom);
      prev.cut = prev.cut || k.cut;
    } else clustered.push({ ...k });
  }
  if (clustered.length && clustered[0].t > 0)
    clustered.unshift({ t: 0, cx: 0.5, cy: 0.5, zoom: 1, cut: false });
  const out: CamKey[] = [];
  for (const k of clustered) {
    const prev = out[out.length - 1];
    if (prev && style !== 'aggressive') {
      const dx = k.cx - prev.cx,
        dy = k.cy - prev.cy;
      const dist = Math.hypot(dx, dy);
      const zd = Math.abs(k.zoom - prev.zoom);
      if (dist < CAM.dedupeDist && zd < CAM.dedupeZoomDelta) {
        prev.cx = (prev.cx + k.cx) / 2;
        prev.cy = (prev.cy + k.cy) / 2;
        prev.zoom = Math.max(prev.zoom, k.zoom);
        prev.cut = prev.cut || k.cut;
        continue;
      }
    }
    out.push({ ...k });
  }
  if (style !== 'aggressive') {
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1],
        b = out[i];
      const dx = b.cx - a.cx,
        dy = b.cy - a.cy;
      const dist = Math.hypot(dx, dy);
      const zd = Math.abs(b.zoom - a.zoom);
      const shouldCut = dist >= CAM.cutMoveThreshold || zd >= CAM.cutZoomThreshold;
      b.cut = b.cut && shouldCut;
    }
  }
  return out;
}

export function sampleCamera(camKeys:CamKey[], style:string, ms:number, CAM:CamConfig){
  if(!camKeys.length) return {cx:.5,cy:.5,zoom:1,cut:false,t:0};
  if(style==='aggressive'){
    let cur=camKeys[0]; for(const k of camKeys){ if(k.t<=ms) cur=k; else break; }
    const idx=camKeys.indexOf(cur); const nxt=camKeys[idx+1];
    if(nxt){
      if(nxt.cut){
        if(ms<nxt.t) return {...cur,cut:false,t:cur.t};
        if(ms>=nxt.t && ms<nxt.t+140){ const kk=(ms-nxt.t)/140; const ease=kk<.5?4*kk*kk*kk:1-Math.pow(-2*kk+2,3)/2; return {cx:nxt.cx, cy:nxt.cy, zoom:nxt.zoom*(1+0.08*(1-ease)), cut:true, t:nxt.t}; }
      } else {
        const lead=420; if(ms>=nxt.t-lead && ms<nxt.t){ const k=1-(nxt.t-ms)/lead; const ease=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2; return {cx:cur.cx+(nxt.cx-cur.cx)*ease, cy:cur.cy+(nxt.cy-cur.cy)*ease, zoom:cur.zoom+(nxt.zoom-cur.zoom)*ease, cut:false, t:cur.t}; }
      }
    }
    return {...cur,t:cur.t};
  }
  const lead=CAM.leadMs;
  const next=camKeys.find(k=>k.t>ms);
  if(next){ const prevIndex=camKeys.indexOf(next)-1; const prev=prevIndex>=0?camKeys[prevIndex]:camKeys[0]; if(ms>=next.t-lead && ms<next.t){ const k=1-(next.t-ms)/lead; const ease=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2; return {cx:prev.cx+(next.cx-prev.cx)*ease, cy:prev.cy+(next.cy-prev.cy)*ease, zoom:prev.zoom+(next.zoom-prev.zoom)*ease*.85, cut:false,t:prev.t}; } }
  for(let i=camKeys.length-1;i>=0;i--){ if(ms>=camKeys[i].t){ const a=camKeys[i], b=camKeys[i+1]; if(!b) return {...a,t:a.t}; const span=b.t-a.t; const k=span>0?Math.min(1,(ms-a.t)/span):0; const ease=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2; return {cx:a.cx+(b.cx-a.cx)*ease, cy:a.cy+(b.cy-a.cy)*ease, zoom:a.zoom+(b.zoom-a.zoom)*ease, cut:b.cut&&k>0.9,t:a.t}; } }
  return {...camKeys[0], t:camKeys[0].t};
}
