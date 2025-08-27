// Signal boot immediately so host can detect page script execution even before Three loads
window.__COMPOSITOR_BOOT = true; window.__COMPOSITOR_MAIN_STARTED = true; console.log('[teaser] BOOT (early)');
try { if (window.__COMPOSITOR_MODULE_LOADED) window.__COMPOSITOR_MODULE_LOADED(); } catch {}

// Guard against duplicate loads (e.g. watchdog dynamic import fallback)
if (window.__COMPOSITOR_RAN) {
  console.log('[teaser] duplicate compositor.js load ignored');
  // If first run failed to ever signal readiness, offer a minimal signal now.
  if (!window.COMPOSITOR_READY) { console.warn('[teaser] duplicate load providing readiness fallback'); /* @ts-ignore */ window.COMPOSITOR_READY = true; }
} else {
  window.__COMPOSITOR_RAN = true;

  // Dynamic import of Three.js via CDN because we serve raw modules without bundling.
  let THREE = null; // will hold module namespace exports
  async function loadThree(){
    // Try local served version first
    try {
      const threeModule = await import('/vendor/three/three.module.js');
      // Three.js module exports individual classes, so we reconstruct a THREE object
      THREE = threeModule;
      console.log('[teaser] three loaded (local)', Object.keys(THREE).length, 'exports');
    } catch(e){ console.warn('[teaser] local three load failed, falling back to CDN', e); }
    if(!THREE) {
      try {
        const threeModule = await import('https://unpkg.com/three@0.166.0/build/three.module.js');
        THREE = threeModule;
        console.log('[teaser] three loaded (cdn)', Object.keys(THREE).length, 'exports');
      } catch(e) {
        console.error('[teaser] failed to load three from CDN', e);
        // @ts-ignore
        window.COMPOSITOR_READY = true;
      }
    }
    return THREE;
  }
  await loadThree();
  if(!THREE){
    console.error('[teaser] Three.js unavailable; aborting scene setup');
    // Provide minimal ready signal to unblock compose
    // @ts-ignore
    window.COMPOSITOR_READY = true;
  } else {
    // Destructure frequently used exports so we can minify references and avoid relying on a global symbol
    const {
      Scene, Color, Fog, PerspectiveCamera, WebGLRenderer,
      AmbientLight, DirectionalLight, SphereGeometry, MeshBasicMaterial,
      Mesh, GridHelper, VideoTexture, LinearFilter, PlaneGeometry,
      MeshStandardMaterial, Group,
    } = THREE;

    // --- Original scene setup & recording logic now inside duplicate-load guard ---
    const params = new URLSearchParams(location.search);
    const debug = params.get('debug') === '1';
    function dbg(...a){ if(debug) console.log('[dbg]', ...a); }
    const videoUrl = params.get('video');
    const title = decodeURIComponent(params.get('title')||'');
    const subtitle = decodeURIComponent(params.get('subtitle')||'');
    const theme = params.get('theme') || 'sky';
    // (boot marker already set at top)
    let timeline = [];
    try {
      const tl = params.get('timeline');
      if (tl) timeline = JSON.parse(atob(tl));
    } catch(e) { console.warn('timeline parse failed', e); }
    dbg('timeline events', timeline.length);

    const titleEl = document.getElementById('title');
    const subtitleEl = document.getElementById('subtitle');
    if (titleEl) titleEl.textContent = title;
    if (subtitleEl) subtitleEl.textContent = subtitle;
    const originEl = document.getElementById('origin');
    if (originEl) originEl.textContent = window.location.host;
    const fallbackDuration = parseInt(params.get('fallbackDuration')||'0',10);

  const scene = new Scene();
  const fogColor = new Color('#0a0f25');
  scene.fog = new Fog(fogColor, 10, 60);

  const camera = new PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 200);
    // Drop preserveDrawingBuffer for performance; we'll render a final frame manually for cover
  const renderer = new WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Lighting
  scene.add(new AmbientLight(0xffffff, 0.9));
  const dir = new DirectionalLight(0xffffff, 0.4); dir.position.set(5,10,7); scene.add(dir);

    // Environment / theme specifics
    if (theme === 'sky' || theme === 'teaser') {
  const skyGeo = new SphereGeometry(160, 42, 18);
  const skyMat = new MeshBasicMaterial({ color: theme === 'teaser' ? 0x0d132b : 0x1e2958, side: THREE.BackSide });
  const sky = new Mesh(skyGeo, skyMat);
      scene.add(sky);
    }

    // Subtle grid plane (hidden in teaser until reveal)
  const grid = new GridHelper(140, 70, 0x335577, 0x223344);
    (grid.material).opacity = 0.18;
    (grid.material).transparent = true;
    if (theme !== 'teaser') scene.add(grid);

    // Video texture plane with robust load
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    video.muted = true; // autoplay needs mute
    video.loop = false;
    video.preload = 'auto';
    async function initVideo(){
      if(!videoUrl) return;
      try {
      console.log('[teaser] fetch video start', videoUrl);
        const resp = await fetch(videoUrl, { cache:'no-store' });
        const blob = await resp.blob();
        const obj = URL.createObjectURL(blob);
        video.src = obj;
        console.log('[teaser] video blob loaded size', blob.size);
      } catch(e){
        console.warn('[teaser] video fetch failed fallback direct src', e);
        video.src = videoUrl;
      }
    }
    initVideo();

  const tex = new VideoTexture(video);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
    tex.anisotropy = 4;

    // Base video plane
  const planeGeometry = new PlaneGeometry(16, 9, 32, 18);
  const planeMaterial = new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.02 });
  const plane = new Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI * 0.18;
    scene.add(plane);

    // Teaser theme: add parallax reflection panels behind plane for depth
  const parallaxGroup = new Group();
    if (theme === 'teaser') {
      for (let i=0;i<6;i++) {
  const geo = new PlaneGeometry(16, 9);
  const mat = new MeshBasicMaterial({ color: 0x0a162b, transparent:true, opacity:0.04 + Math.random()*0.05 });
  const m = new Mesh(geo, mat);
        m.position.set((Math.random()-0.5)*8, (Math.random()-0.5)*4, -4 - i*1.8);
        m.rotation.x = -Math.PI*0.18 + (Math.random()-0.5)*0.05;
        m.rotation.y = (Math.random()-0.5)*0.3;
        parallaxGroup.add(m);
      }
      scene.add(parallaxGroup);
    }

    camera.position.set(0, 8, 22);

    // Teaser overlay activation
    const lbTop = document.getElementById('lbTop');
    const lbBottom = document.getElementById('lbBottom');
    const vignette = document.getElementById('vignette');
    const grainCanvas = document.getElementById('grain');
    if (theme === 'teaser') {
      [lbTop, lbBottom, vignette, grainCanvas].forEach(el => { if (el) el.hidden = false; });
    }

    // Film grain generation (simple static noise updated per frame subset)
    let grainCtx = null;
    if (grainCanvas instanceof HTMLCanvasElement) {
      grainCanvas.width = window.innerWidth/2;
      grainCanvas.height = window.innerHeight/2;
      grainCtx = grainCanvas.getContext('2d');
    }

    let startTime = 0;
    let frameIndex = 0;
    let recordingChunks = [];
    let recorder = null;
    let recorderStarted = false;
    let coverCaptured = false;
    let hardStopTimer = null;
    let plannedStopTimer = null;
    let readySignalled = false;

    function signalReadyOnce(){
      if(readySignalled) { dbg('signalReadyOnce already signalled'); return; }
      readySignalled = true;
      // @ts-ignore
      window.COMPOSITOR_READY = true;
      console.log('[teaser] COMPOSITOR_READY signalled');
    }

    function captureCoverFrame(){
      try {
        // Ensure a fresh render so we get the latest frame even without preserveDrawingBuffer
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      } catch(e){ console.warn('[teaser] captureCoverFrame failed', e); return ''; }
    }

    function schedulePlannedStop(){
      if (video.duration && !isNaN(video.duration) && video.duration>0) {
        const stopIn = Math.max(500, video.duration*1000 - 220); // stop ~0.22s early to avoid stall at exact end
        if (plannedStopTimer) clearTimeout(plannedStopTimer);
        plannedStopTimer = setTimeout(()=>{
          if (recorder && recorder.state === 'recording') { console.log('[teaser] planned stop near end', video.currentTime,'/',video.duration); recorder.stop(); }
        }, stopIn);
        console.log('[teaser] scheduled planned stop in', stopIn,'ms (video.duration', video.duration,')');
      }
    }

    function startRecording() {
      if (recorderStarted) { console.log('[teaser] startRecording ignored - already started'); return; }
      const stream = renderer.domElement.captureStream(30);
      let mime = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = e => { if (e.data.size) recordingChunks.push(e.data); };
      recorder.onstop = async () => {
        console.log('[teaser] recorder onstop fired; building blob');
        const blob = new Blob(recordingChunks, { type: 'video/webm' });
        let base64 = '';
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          const chunkSize = 0x8000; // 32KB
          let binary = '';
          for (let i=0;i<bytes.length;i+=chunkSize){
            const sub = bytes.subarray(i, i+chunkSize);
            binary += String.fromCharCode.apply(null, Array.from(sub));
          }
          base64 = btoa(binary);
        } catch(e){
          console.error('[teaser] base64 encode failed', e);
        }
      let cover = '';
      try { cover = captureCoverFrame(); } catch(e){ console.warn('[teaser] cover capture failed', e); }
        try {
          // @ts-ignore
          if (window.nodeDone) {
            await window.nodeDone(base64, cover);
          } else {
            console.warn('[teaser] window.nodeDone missing');
          }
        } catch(e){
          console.error('[teaser] nodeDone call failed', e);
        }
        console.log('[teaser] recorder stopped, signalling ready');
        signalReadyOnce();
      };
      recorder.start();
      dbg('recorder state', recorder.state);
      recorderStarted = true;
      console.log('[teaser] recorder started mime', mime);
      // Expose manual stop for Node side fallback
      window.RECORDER_FORCE_STOP = () => { if (recorder && recorder.state === 'recording') recorder.stop(); };
      // Schedule hard stop relative to actual recorder start; if video metadata known use that
      let targetMs = (fallbackDuration>0? fallbackDuration: 8000);
      if (!isNaN(video.duration) && video.duration>0) {
        targetMs = Math.max(targetMs, video.duration * 1000);
      }
      const hardStop = targetMs + 800; // tail padding
      if (hardStopTimer) clearTimeout(hardStopTimer);
      hardStopTimer = setTimeout(()=>{
        if (recorder && recorder.state === 'recording') { console.warn('[teaser] hard stop'); recorder.stop(); }
        else if(!readySignalled){ console.warn('[teaser] hard stop with no recording; signalling ready'); signalReadyOnce(); }
      }, hardStop);
      console.log('[teaser] scheduled hard stop in', hardStop,'ms (targetMs',targetMs, 'video.duration', video.duration,')');
      schedulePlannedStop();
    }

    // Derive camera focus keyframes from timeline
    const camKeys = (() => {
      if (!timeline.length) return [];
      const keys = [];
      for (const ev of timeline) {
        if (!('x' in ev) || ev.x == null) continue;
        const zBase = ev.type === 'click' ? 1.6 : ev.type === 'type' ? 1.5 : 1.3;
        keys.push({ t: ev.t, cx: ev.x, cy: ev.y, zoom: zBase, cut: ev.type === 'click' });
      }
      keys.sort((a,b)=>a.t-b.t);
      if (keys.length && keys[0].t > 0) keys.unshift({ t: 0, cx:0.5, cy:0.5, zoom:1.0 });
      return keys;
    })();

    function sampleCam(targetMs) {
      if (!camKeys.length) return { cx:0.5, cy:0.5, zoom:1.0, cut:false };
      for (let i=camKeys.length-1;i>=0;i--) {
        if (targetMs >= camKeys[i].t) {
          const a = camKeys[i];
          const b = camKeys[i+1];
          if (!b) return a;
          const span = b.t - a.t;
          const k = span>0 ? Math.min(1,(targetMs - a.t)/span) : 0;
          const ease = k<0.5? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2;
          return { cx: a.cx + (b.cx - a.cx)*ease, cy: a.cy + (b.cy - a.cy)*ease, zoom: a.zoom + (b.zoom - a.zoom)*ease, cut: b.cut && k>0.92 };
        }
      }
      return camKeys[0];
    }

    function animate(t) {
  requestAnimationFrame(animate);
  if (!startTime) startTime = t;
  const elapsed = (t - startTime) / 1000;
  // Determine focus inside video plane normalized (-8..8 horizontally, -4.5..4.5 vertically because plane 16x9 centered)
  const focus = sampleCam((t - startTime));
  const fx = (focus.cx - 0.5) * 16; // map to plane local coords width 16
  const fy = (0.5 - focus.cy) * 9;  // invert y

  if (theme === 'teaser') {
    // Isometric style dolly + subtle orbital tilt
    const easeIn = (k)=> k<0.5? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2;
    const k = Math.min(1, elapsed / 8); // 8s settle
    const e = easeIn(k);
    const baseZ = 28 - e * 10 - (focus.zoom - 1.0) * 6; // extra zoom
    const lateral = Math.sin(elapsed * 0.35) * 5 * (1-e*0.2) + fx * 0.15;
    camera.position.x = lateral;
    camera.position.y = 9 + Math.sin(elapsed * 0.6) * 0.8 + e*1.2 + fy * 0.05;
    camera.position.z = baseZ;
    camera.rotation.z = Math.sin(elapsed * 0.15) * 0.02 + fx * 0.002; // roll
    camera.lookAt(fx*0.4, 1.5 + fy*0.15, 0);
    plane.rotation.y = Math.sin(elapsed * 0.5) * 0.22;
    // Edge elevation (lift corners slightly based on focus)
    const elev = (focus.zoom -1) * 0.4;
    plane.position.y = elev;
    parallaxGroup.children.forEach((m,i)=>{
      m.position.x *= 0.995; // slight drift damping
      m.position.y += Math.sin(elapsed*0.3 + i) * 0.0008;
      m.material.opacity = 0.03 + Math.sin(elapsed*0.4 + i)*0.015;
    });
  } else {
    // Default path
    camera.position.x = Math.sin(elapsed * 0.25) * 6;
    camera.position.y = 8 + Math.sin(elapsed * 0.3) * 1.2;
    camera.position.z = 22 - elapsed * 1.2; // slow push in
    camera.lookAt(0,0,0);
    plane.rotation.y = Math.sin(elapsed * 0.4) * 0.15;
  }

  // Grain update
  if (grainCtx) {
    frameIndex++;
    if (frameIndex % 3 === 0) { // update every 3rd frame to reduce GPU stalls
    const w = grainCanvas.width, h = grainCanvas.height;
    const id = grainCtx.createImageData(w, h);
    for (let i=0;i<id.data.length;i+=4){
      const v = Math.random()*255; id.data[i]=v; id.data[i+1]=v; id.data[i+2]=v; id.data[i+3]=40; }
    grainCtx.putImageData(id,0,0);
    // scale up to full screen via CSS
    grainCanvas.style.width = '100%';
    grainCanvas.style.height = '100%';
    }
  }

  if (video.readyState >= 2 && video.currentTime > 0) {
    if (!coverCaptured && video.currentTime > 0.5) {
      coverCaptured = true; // already captured via recorder stop
    }
      if (video.ended) {
        if (recorder && recorder.state === 'recording') { console.log('[teaser] video ended -> stopping recorder'); recorder.stop(); }
      }
  }
  // Simulate quick “cut” flash by brief exposure tweak
  if (focus.cut) {
    renderer.toneMappingExposure = 1.3;
  } else {
    renderer.toneMappingExposure += (1 - renderer.toneMappingExposure)*0.08;
  }
      renderer.render(scene, camera);
    }

video.addEventListener('canplay', () => {
  console.log('[teaser] video canplay duration', video.duration, 'readyState', video.readyState, 'video.currentTime', video.currentTime);
  const tryPlay = () => video.play().catch(e=>console.warn('play failed', e));
  tryPlay();
  // Retry play a few times if currentTime not advancing
  let retries = 0;
  const playCheck = setInterval(()=>{
    dbg('playCheck currentTime', video.currentTime, 'readyState', video.readyState);
    if (video.currentTime > 0.05) { clearInterval(playCheck); }
    else if(retries++ < 5){ tryPlay(); }
    else { clearInterval(playCheck); }
  }, 400);
  const delay = theme==='teaser'?400:0;
  setTimeout(()=>startRecording(), delay);
  if (theme==='teaser') setTimeout(()=>{ if(!scene.children.includes(grid)) scene.add(grid); }, 3000);
});
['loadstart','loadeddata','loadedmetadata','waiting','playing','timeupdate','ended','error','stalled','suspend'].forEach(ev=>{
  video.addEventListener(ev, ()=> dbg('video event', ev, 'ct', video.currentTime, 'rs', video.readyState));
});

// Watchdog start (if canplay delayed or failed) and final readiness fallback
setTimeout(()=>{ if(!recorderStarted){ console.log('[teaser] watchdog startRecording'); startRecording(); } else dbg('watchdog sees recorder already started'); }, 2500);
// Absolute readiness fallback in case nothing worked (ensures compose unblocks)
setTimeout(()=>{ if(!readySignalled){ console.warn('[teaser] ultimate readiness fallback'); signalReadyOnce(); } }, (fallbackDuration>0? fallbackDuration: 8000) + 5000);

video.addEventListener('ended', () => {
  if (recorder && recorder.state === 'recording') recorder.stop();
});

    animate(0);
  }
}

