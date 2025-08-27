// High quality DemoSnap video player logic
const qs = (s)=>document.querySelector(s);
const vid = qs('#vid');
const playBtn = qs('#playBtn');
const timeLabel = qs('#timeLabel');
const seek = qs('#seek');
const muteBtn = qs('#muteBtn');
const speedBtn = qs('#speedBtn');
const fsBtn = qs('#fsBtn');
const dlBtn = qs('#dlBtn');
const pipBtn = qs('#pipBtn');
const openFile = qs('#openFile');
const volume = qs('#volume');
const sharpBtn = qs('#sharpBtn');
const resetBtn = qs('#resetBtn');
const statsBox = qs('#stats');
const qualityBadge = qs('#qualityBadge');

// Optional sharpening via offscreen canvas
let sharpenEnabled = false;
let procCanvas = document.createElement('canvas');
let procCtx = procCanvas.getContext('2d');
let lastFrameTime = performance.now();
let frameCounter = 0; let fpsTimer = 0; let fps = 0; let dropped=0;
let autoSrcSet = [];
const paramSrc = new URLSearchParams(location.search).get('src');

// Attach default source if query provided, else wait for open
if (paramSrc) { setSource(paramSrc); }

function setSource(url){
  vid.src = url; vid.load(); playBtn.textContent='Play';
}

openFile?.addEventListener('click', async ()=>{
  const inp = document.createElement('input'); inp.type='file'; inp.accept='video/webm,video/mp4,video/*';
  inp.onchange = ()=>{ const f = inp.files?.[0]; if (f) { const url = URL.createObjectURL(f); setSource(url); } };
  inp.click();
});

function fmt(t){ if(!isFinite(t)) return '00:00'; const m = Math.floor(t/60); const s = Math.floor(t%60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }

function updateTime(){ timeLabel.textContent = `${fmt(vid.currentTime)} / ${fmt(vid.duration||0)}`; }

playBtn?.addEventListener('click', ()=>{ if (vid.paused) { vid.play(); } else vid.pause(); });
vid.addEventListener('play', ()=> playBtn.textContent='Pause');
vid.addEventListener('pause', ()=> playBtn.textContent='Play');
vid.addEventListener('timeupdate', ()=> { updateTime(); if(!seekDragging) seek.value = String(Math.round((vid.currentTime/vid.duration)*1000)); });
vid.addEventListener('loadedmetadata', ()=>{ updateTime(); });

let seekDragging=false;
seek?.addEventListener('input', ()=>{ seekDragging=true; const k = parseInt(seek.value,10)/1000; vid.currentTime = k * (vid.duration||0); });
seek?.addEventListener('change', ()=>{ seekDragging=false; });

muteBtn?.addEventListener('click', ()=>{ vid.muted = !vid.muted; muteBtn.textContent = vid.muted? 'Unmute':'Mute'; });
volume?.addEventListener('input', ()=>{ vid.volume = parseFloat(volume.value); if (vid.volume>0) { vid.muted=false; muteBtn.textContent='Mute'; } });

const speeds=[1,1.25,1.5,1.75,2,0.75,0.5]; let spIdx=0;
speedBtn?.addEventListener('click', ()=>{ spIdx=(spIdx+1)%speeds.length; vid.playbackRate=speeds[spIdx]; speedBtn.textContent=speeds[spIdx].toFixed(2)+'x'; });

fsBtn?.addEventListener('click', ()=>{ if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); });

pipBtn?.addEventListener('click', async ()=>{ if (document.pictureInPictureElement) { document.exitPictureInPicture(); } else if (document.pictureInPictureEnabled) { try { await vid.requestPictureInPicture(); } catch(e){ console.warn('PiP failed', e); } } });

dlBtn?.addEventListener('click', ()=>{ if (!vid.src) return; const a=document.createElement('a'); a.href=vid.src; a.download='video'; a.click(); });

sharpBtn?.addEventListener('click', ()=>{ sharpenEnabled=!sharpenEnabled; sharpBtn.textContent = sharpenEnabled? 'Sharp-':'Sharp+'; if(sharpenEnabled){ enableProcessing(); } else { disableProcessing(); }});
resetBtn?.addEventListener('click', ()=>{ sharpenEnabled=false; sharpBtn.textContent='Sharp+'; disableProcessing(); vid.playbackRate=1; speedBtn.textContent='1.00x'; vid.currentTime=0; });

function enableProcessing(){ if(vid.crossOrigin!=="anonymous") vid.crossOrigin='anonymous'; if(!procCanvas.parentNode){ procCanvas.style.position='absolute'; procCanvas.style.inset='0'; procCanvas.style.width='100%'; procCanvas.style.height='100%'; procCanvas.style.mixBlendMode='normal'; vid.after(procCanvas); vid.style.visibility='hidden'; }
  procCanvas.width = vid.videoWidth; procCanvas.height = vid.videoHeight;
}
function disableProcessing(){ if(procCanvas.parentNode){ procCanvas.remove(); vid.style.visibility=''; } }

function processFrame(){ if(!sharpenEnabled) return; if(vid.readyState<2) return; procCanvas.width = vid.videoWidth; procCanvas.height = vid.videoHeight; procCtx.drawImage(vid,0,0); const img=procCtx.getImageData(0,0,procCanvas.width,procCanvas.height); const d=img.data; // simple unsharp
  // 1-pass horizontal blur into temp
  const w=procCanvas.width,h=procCanvas.height; const tmp=new Uint8ClampedArray(d.length);
  for(let y=0;y<h;y++){ for(let x=0;x<w;x++){ const i=(y*w+x)*4; let r=0,g=0,b=0,cnt=0; for(let dx=-1;dx<=1;dx++){ const xx=Math.min(w-1,Math.max(0,x+dx)); const ii=(y*w+xx)*4; r+=d[ii];g+=d[ii+1];b+=d[ii+2];cnt++; } tmp[i]=r/cnt; tmp[i+1]=g/cnt; tmp[i+2]=b/cnt; tmp[i+3]=255; }}
  // sharpen
  for(let y=0;y<h;y++){ for(let x=0;x<w;x++){ const i=(y*w+x)*4; const r=d[i],g=d[i+1],b=d[i+2]; const br=tmp[i],bg=tmp[i+1],bb=tmp[i+2]; const amt=0.55; d[i]=Math.min(255,Math.max(0,r+(r-br)*amt)); d[i+1]=Math.min(255,Math.max(0,g+(g-bg)*amt)); d[i+2]=Math.min(255,Math.max(0,b+(b-bb)*amt)); }}
  procCtx.putImageData(img,0,0);
}

function rafLoop(){ requestAnimationFrame(rafLoop); const now=performance.now(); const dt=now-lastFrameTime; if(dt<14) { return; } lastFrameTime=now; frameCounter++; fpsTimer+=dt; if(fpsTimer>1000){ fps=frameCounter; frameCounter=0; fpsTimer=0; updateStats(); }
  processFrame();
}
rafLoop();

function updateStats(){ if(!statsBox) return; statsBox.textContent=`FPS ${fps}\nScale 1x\nSharp ${sharpenEnabled?'on':'off'}`; }

// Auto quality (placeholder: could choose among multiple source qualities). For now mark as AUTO/Hi.
if (qualityBadge) qualityBadge.textContent = 'HI';

// Keyboard shortcuts
window.addEventListener('keydown', (e)=>{
  if (e.target instanceof HTMLInputElement) return;
  switch(e.key){
    case ' ': playBtn?.click(); e.preventDefault(); break;
    case 'm': muteBtn?.click(); break;
    case 'f': fsBtn?.click(); break;
    case 'ArrowRight': vid.currentTime = Math.min(vid.duration, vid.currentTime + 5); break;
    case 'ArrowLeft': vid.currentTime = Math.max(0, vid.currentTime - 5); break;
    case '+': case '=': volume.value = String(Math.min(1, parseFloat(volume.value)+0.05)); volume.dispatchEvent(new Event('input')); break;
    case '-': volume.value = String(Math.max(0, parseFloat(volume.value)-0.05)); volume.dispatchEvent(new Event('input')); break;
  }
});

// Expose for debugging
window.player = { setSource, enableProcessing, disableProcessing };
