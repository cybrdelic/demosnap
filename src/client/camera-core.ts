// TypeScript port of camera-core.js
export interface TimelineEvent { t:number; type:string; x?:number; y?:number; w?:number; h?:number; }
export interface CamKey { t:number; cx:number; cy:number; zoom:number; cut:boolean; }
export interface CamConfig { leadMs:number; clusterMs:number; maxZoom:number; posLerp:number; zoomLerp:number; movementDeadZone:number; exposureCut:number; exposureLerp:number; settleSeconds:number; idleDriftAmp:number; idlePushInZ:number; dedupeDist:number; dedupeZoomDelta:number; cutMoveThreshold:number; cutZoomThreshold:number; }

export function buildCamConfig(style:string):CamConfig {
  const CAM:CamConfig={leadMs:900,clusterMs:600,maxZoom:3.2,posLerp:.065,zoomLerp:.07,movementDeadZone:.018,exposureCut:1.08,exposureLerp:.06,settleSeconds:8,idleDriftAmp:5,idlePushInZ:10,dedupeDist:.022,dedupeZoomDelta:.18,cutMoveThreshold:.06,cutZoomThreshold:.28};
  if(style==='aggressive'){
    CAM.clusterMs=160; CAM.maxZoom=4.1; CAM.idleDriftAmp=2.2; CAM.posLerp=.22; CAM.zoomLerp=.18;
  }
  return CAM;
}

export function buildCamKeys(timeline:TimelineEvent[], style:string, CAM:CamConfig):CamKey[] {
  const keys:CamKey[]=[];
  for(const ev of timeline){
    if(ev.x==null || ev.y==null) continue;
    let z=1.25;
    if(ev.type==='prefocus') z=1.35; else if(ev.type==='click') z=1.7; else if(ev.type==='type') z=1.52; else if(ev.type==='press') z=1.85; else if(ev.type==='wait') z=1.4;
    if(style==='aggressive'){
      if(ev.type==='click') z+=0.55; else if(ev.type==='type') z+=0.45; else if(ev.type==='press') z+=0.65;
    }
    if(ev.w && ev.h){ const area=ev.w*ev.h; z*=Math.min(2.8,1+(0.25-Math.min(0.25,area))*3.8); }
    z=Math.min(z,CAM.maxZoom);
    const cut = style==='aggressive'? (ev.type!=='prefocus') : (ev.type==='click');
    keys.push({t:ev.t,cx:ev.x,cy:ev.y,zoom:z,cut});
  }
  keys.sort((a,b)=>a.t-b.t);
  const clustered:CamKey[]=[];
  for(const k of keys){
    const prev=clustered[clustered.length-1];
    if(prev && (k.t-prev.t) < CAM.clusterMs){
      prev.cx=(prev.cx+k.cx)/2; prev.cy=(prev.cy+k.cy)/2; prev.zoom=Math.max(prev.zoom,k.zoom); prev.cut=prev.cut||k.cut;
    } else clustered.push({...k});
  }
  if(clustered.length && clustered[0].t>0) clustered.unshift({t:0,cx:.5,cy:.5,zoom:1,cut:false});
  const out:CamKey[]=[];
  for(const k of clustered){
    const prev=out[out.length-1];
    if(prev && style!=='aggressive'){
      const dx=k.cx-prev.cx, dy=k.cy-prev.cy; const dist=Math.hypot(dx,dy); const zd=Math.abs(k.zoom-prev.zoom);
      if(dist<CAM.dedupeDist && zd<CAM.dedupeZoomDelta){
        prev.cx=(prev.cx+k.cx)/2; prev.cy=(prev.cy+k.cy)/2; prev.zoom=Math.max(prev.zoom,k.zoom); prev.cut=prev.cut||k.cut; continue;
      }
    }
    out.push({...k});
  }
  if(style!=='aggressive'){
    for(let i=1;i<out.length;i++){
      const a=out[i-1], b=out[i];
      const dx=b.cx-a.cx, dy=b.cy-a.cy; const dist=Math.hypot(dx,dy); const zd=Math.abs(b.zoom-a.zoom);
      const shouldCut = dist>=CAM.cutMoveThreshold || zd>=CAM.cutZoomThreshold; b.cut = b.cut && shouldCut;
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
