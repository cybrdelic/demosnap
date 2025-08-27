import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  VideoTexture,
  WebGLRenderer,
  WebGLRenderTarget
} from '/vendor/three/three.module.js';

// Signal boot immediately so host can detect page script execution.
window.__COMPOSITOR_BOOT = true; window.__COMPOSITOR_MAIN_STARTED = true; console.log('[teaser] BOOT (early)');
try { if (window.__COMPOSITOR_MODULE_LOADED) window.__COMPOSITOR_MODULE_LOADED(); } catch {}

if (window.__COMPOSITOR_RAN) {
  console.log('[teaser] duplicate compositor.js load ignored');
  if (!window.COMPOSITOR_READY) { console.warn('[teaser] duplicate load providing readiness fallback'); /* @ts-ignore */ window.COMPOSITOR_READY = true; }
} else {
  window.__COMPOSITOR_RAN = true;
  // --- Scene + cinematic pipeline ---

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
  const targetBitrateKbps = parseInt(params.get('bitrate')||'0',10) || 0;
  const targetFps = Math.max(1, parseInt(params.get('fps')||'30',10));
  const qualityPreset = (params.get('quality')||'auto');
  const ctaLink = params.get('link') || '';

  const scene = new Scene();
  const fogColor = new Color('#0a0f25');
  scene.fog = new Fog(fogColor, 10, 60);

  const camera = new PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 200);
    // Drop preserveDrawingBuffer for performance; we'll render a final frame manually for cover
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  let internalScale = 1.0;
  function applyRendererSize(){
    const w = Math.max(320, Math.floor(window.innerWidth * internalScale));
    const h = Math.max(180, Math.floor(window.innerHeight * internalScale));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = window.innerWidth + 'px';
    renderer.domElement.style.height = window.innerHeight + 'px';
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  applyRendererSize();
  document.body.appendChild(renderer.domElement);
  window.addEventListener('resize', applyRendererSize);

    // Lighting
  scene.add(new AmbientLight(0xffffff, 0.9));
  const dir = new DirectionalLight(0xffffff, 0.4); dir.position.set(5,10,7); scene.add(dir);

    // Environment / theme specifics
    if (theme === 'sky' || theme === 'teaser') {
  const skyGeo = new SphereGeometry(160, 42, 18);
  const skyMat = new MeshBasicMaterial({ color: theme === 'teaser' ? 0x0d132b : 0x1e2958, side: BackSide });
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
    // CTA overlay if link present
    if (ctaLink) {
      const cta = document.createElement('a');
      cta.href = ctaLink; cta.target = '_blank';
      cta.textContent = new URL(ctaLink).host.replace(/^www\./,'');
      Object.assign(cta.style, { position:'fixed', left:'1rem', bottom:'1rem', padding:'.55rem .9rem', background:'rgba(15,23,42,.72)', color:'#fff', fontSize:'.8rem', letterSpacing:'.06em', textDecoration:'none', border:'1px solid rgba(255,255,255,.12)', borderRadius:'8px', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)', zIndex:50, fontWeight:'500' });
      cta.addEventListener('mouseenter',()=> cta.style.background='rgba(30,41,59,.9)');
      cta.addEventListener('mouseleave',()=> cta.style.background='rgba(15,23,42,.72)');
      document.body.appendChild(cta);
    }

    // Teaser overlay activation
    const lbTop = document.getElementById('lbTop');
    const lbBottom = document.getElementById('lbBottom');
    const vignette = document.getElementById('vignette');
    const grainCanvas = document.getElementById('grain');
    if (theme === 'teaser') {
      [lbTop, lbBottom, vignette, grainCanvas].forEach(el => { if (el) el.hidden = false; });
    }

  // Disable legacy CPU grain (will use shader-based later)
  let grainCtx = null; if (grainCanvas) grainCanvas.hidden = true;

    let startTime = 0;
    let frameIndex = 0;
    let recordingChunks = [];
    let recorder = null;
    let recorderStarted = false;
    let coverCaptured = false;
    let hardStopTimer = null;
    let plannedStopTimer = null;
    let readySignalled = false;
    // Cinematic focus helpers (ring)
    const focusRing = document.getElementById('focusRing');
    // Post-process edge-lift shader pass (replaces CPU edge canvas)
    const edgeCanvasEl = document.getElementById('edgeLift');
    if (edgeCanvasEl) edgeCanvasEl.hidden = true; // legacy canvas no longer used

    // Render target for base scene & post FX quad
    const rt = new WebGLRenderTarget(window.innerWidth, window.innerHeight, { depthBuffer: true });
    const edgeFrag = `precision highp float;\nuniform sampler2D uBase; uniform vec2 uTexel; uniform float uEdge; uniform float uLift; uniform float uBorder; varying vec2 vUv; float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); } void main(){ vec2 t = uTexel; float tl=luma(texture2D(uBase,vUv+vec2(-t.x,-t.y)).rgb); float l =luma(texture2D(uBase,vUv+vec2(-t.x,0.)).rgb); float bl=luma(texture2D(uBase,vUv+vec2(-t.x,t.y)).rgb); float t0=luma(texture2D(uBase,vUv+vec2(0.,-t.y)).rgb); float c =luma(texture2D(uBase,vUv).rgb); float b =luma(texture2D(uBase,vUv+vec2(0.,t.y)).rgb); float tr=luma(texture2D(uBase,vUv+vec2(t.x,-t.y)).rgb); float r =luma(texture2D(uBase,vUv+vec2(t.x,0.)).rgb); float br=luma(texture2D(uBase,vUv+vec2(t.x,t.y)).rgb); float gx=(tr+2.0*r+br)-(tl+2.0*l+bl); float gy=(bl+2.0*b+br)-(tl+2.0*t0+tr); float edge=clamp(sqrt(gx*gx+gy*gy)*uEdge,0.,1.); vec2 d = abs(vUv-0.5)*2.; float border = pow(max(d.x,d.y),1.5); float lift = uLift * mix(1., border, uBorder); vec3 base = texture2D(uBase,vUv).rgb; vec3 lifted = base + edge*lift; gl_FragColor = vec4(lifted,1.); }`;
    const edgeVert = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.); }`;
    const edgeMat = new ShaderMaterial({
      uniforms: {
        uBase: { value: rt.texture },
        uTexel: { value: new Vector2(1/ window.innerWidth, 1/ window.innerHeight) },
        uEdge: { value: 1.0 },
        uLift: { value: 0.18 },
        uBorder: { value: 0.6 },
      },
      vertexShader: edgeVert,
      fragmentShader: edgeFrag,
    });
    const quadGeo = new PlaneGeometry(2,2);
    const quad = new Mesh(quadGeo, edgeMat);
    const postScene = new Scene();
    postScene.add(quad);
    const postCam = new OrthographicCamera(-1,1,1,-1,0,1);

    // Focus / zoom program variables
  const focusEvents = timeline.filter(ev=> ev.type==='click' || ev.type==='type' || ev.type==='type-char');
    let activeFocus = null; // {t,cx,cy,zoom,bbox,w,h}
    let focusScale = 1; // actual scale factor applied (1 = no zoom)
    let focusScaleTarget = 1;
    const focusLookAhead = 420; // ms before event to start move
    function findUpcomingFocus(ms){
      for (const ev of focusEvents){
        if (ms <= ev.t && ev.t - ms < 1600) return ev; // first upcoming within horizon
      }
      return null;
    }
    function updateFocusRing(bbox){
      if(!(focusRing instanceof HTMLElement) || !bbox){ focusRing && (focusRing.style.opacity='0'); return; }
      const pad = 6;
      focusRing.style.left = (bbox.x - pad) + 'px';
      focusRing.style.top = (bbox.y - pad) + 'px';
      focusRing.style.width = (bbox.width + pad*2) + 'px';
      focusRing.style.height = (bbox.height + pad*2) + 'px';
      focusRing.style.opacity = '1';
      focusRing.style.transform = 'translateZ(0) scale(1)';
    }

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
  const recOpts = { mimeType: mime };
  if (targetBitrateKbps > 0) { recOpts['bitsPerSecond'] = targetBitrateKbps * 1000; }
  recorder = new MediaRecorder(stream, recOpts);
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

  let lastFrameTs = performance.now();
    let accTime = 0, accFrames = 0, evalTimer = 0;
    function animate(t) {
  requestAnimationFrame(animate);
  if (!startTime) startTime = t;
  const elapsed = (t - startTime) / 1000;
  const now = performance.now();
  const dt = now - lastFrameTs; lastFrameTs = now; accTime += dt; accFrames++; evalTimer += dt;
  // Desired frame interval derived from targetFps
  const minInterval = 1000 / targetFps * 0.55; // allow some headroom
  if (dt < minInterval) return; // pacing: skip if too soon
  if (evalTimer > 1000 && accFrames > 5) {
    const avg = accTime / accFrames; // ms per (render) frame
    if (qualityPreset === 'max') {
      if (internalScale !== 1.0) { internalScale = 1.0; applyRendererSize(); }
    } else if (qualityPreset === 'high') {
      const minScale = 0.85;
      if (avg > (1000/targetFps)*1.4 && internalScale > minScale) { internalScale = Math.max(minScale, internalScale - 0.04); applyRendererSize(); }
      else if (avg < (1000/targetFps)*0.9 && internalScale < 1.0) { internalScale = Math.min(1.0, internalScale + 0.04); applyRendererSize(); }
    } else { // auto
      const minScale = 0.6;
      if (avg > (1000/targetFps)*1.4 && internalScale > minScale) { internalScale = Math.max(minScale, internalScale - 0.06); applyRendererSize(); }
      else if (avg < (1000/targetFps)*0.85 && internalScale < 1.0) { internalScale = Math.min(1.0, internalScale + 0.06); applyRendererSize(); }
    }
    accTime = 0; accFrames = 0; evalTimer = 0;
  }
  // Determine focus inside video plane normalized (-8..8 horizontally, -4.5..4.5 vertically because plane 16x9 centered)
  const focus = sampleCam((t - startTime));
  const fx = (focus.cx - 0.5) * 16; // map to plane local coords width 16
  const fy = (0.5 - focus.cy) * 9;  // invert y

      // Determine upcoming DOM focus target (approx using recorded selector positions)
      const relMs = (t - startTime);
      const upcoming = findUpcomingFocus(relMs + focusLookAhead);
      if (upcoming && (!activeFocus || upcoming.t !== activeFocus.t)) {
        // Try to resolve selector in live compositor page (may fail; guard)
        let bbox = null;
        try {
          if (upcoming.selector) {
            const el = document.querySelector(upcoming.selector);
            if (el) {
              const r = el.getBoundingClientRect();
              bbox = { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
        } catch{}
        activeFocus = { t: upcoming.t, bbox, w: upcoming.w, h: upcoming.h };
        if (bbox) updateFocusRing(bbox); else updateFocusRing(null);
        // Derive desired scale so ROI covers ~82% of viewport (fast ramp)
        if (upcoming.w && upcoming.h) {
          const desired = 0.82;
          const sw = desired / Math.max(0.001, upcoming.w);
          const sh = desired / Math.max(0.001, upcoming.h);
          const target = Math.min(Math.max(sw, sh), 3.8); // increased clamp for deeper cinematic push
          focusScaleTarget = target;
        } else {
          // Fallback heuristic zoom targets (stronger emphasis on typing / clicks)
          focusScaleTarget = upcoming.type === 'type' ? 2.2 : 1.65;
        }
      }
      if (activeFocus && relMs - activeFocus.t > 1200) { // fade ring after some time
        updateFocusRing(null); activeFocus = null; focusScaleTarget = 1; }
      // Fast ease toward target (very snappy => higher smoothing factor)
  // Slightly snappier interpolation toward target
      focusScale += (focusScaleTarget - focusScale) * 0.46;
      // Micro pulses for rapid type-char events (recent within 140ms)
      const recentChar = timeline.slice(-12).reverse().find(ev=> ev.type==='type-char' && (relMs - ev.t) < 140);
      if (recentChar) {
        const pulse = 1 + Math.min(0.06, (140-(relMs-recentChar.t))/140 * 0.06);
        focusScale *= pulse;
      }
      if (Math.abs(focusScale - 1) < 0.002) focusScale = 1;

  if (theme === 'teaser') {
    // Isometric style dolly + subtle orbital tilt
    const easeIn = (k)=> k<0.5? 4*k*k*k : 1 - Math.pow(-2*k+2,3)/2;
    const k = Math.min(1, elapsed / 8); // 8s settle
    const e = easeIn(k);
  const baseZ = (28 - e * 10) / focusScale; // direct scale -> dolly in
        // Apply additional pan toward active focus bbox center if available
        let panOffsetX = 0, panOffsetY = 0;
        if (activeFocus && activeFocus.bbox) {
          const bb = activeFocus.bbox;
          const cxN = (bb.x + bb.width/2) / window.innerWidth; // 0..1 center
          const cyN = (bb.y + bb.height/2) / window.innerHeight;
          panOffsetX = (cxN - 0.5) * 12 * (focusScale-1);
          panOffsetY = (0.5 - cyN) * 6 * (focusScale-1);
        }
        const lateral = Math.sin(elapsed * 0.35) * 5 * (1-e*0.2) + fx * 0.15 + panOffsetX;
    camera.position.x = lateral;
        camera.position.y = 9 + Math.sin(elapsed * 0.6) * 0.8 + e*1.2 + fy * 0.05 + panOffsetY*0.6;
    camera.position.z = baseZ;
    camera.rotation.z = Math.sin(elapsed * 0.15) * 0.02 + fx * 0.002; // roll
        camera.lookAt(fx*0.4 + panOffsetX*0.2, 1.5 + fy*0.15 + panOffsetY*0.3, 0);
        plane.rotation.y = Math.sin(elapsed * 0.5) * 0.22 + panOffsetX*0.01;
    // Edge elevation (lift corners slightly based on focus)
  const elev = (focusScale -1) * 0.4;
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

  // (CPU grain removed; shader-based grain will use time uniform when integrated)

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
  renderer.toneMappingExposure = 1.5;
  } else {
    renderer.toneMappingExposure += (1 - renderer.toneMappingExposure)*0.08;
  }
  // Two-pass render: base scene -> RT, then post quad with edge-lift shader -> screen
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  if (edgeMat && edgeMat.uniforms && edgeMat.uniforms.uTime) edgeMat.uniforms.uTime.value = elapsed;
  renderer.render(postScene, postCam);
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
