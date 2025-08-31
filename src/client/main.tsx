import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import type { ShaderState, TimelineEvent } from '../types/shared.js';
import { buildCamConfig, buildCamKeys, sampleCamera } from './camera-core.js';
import { ShaderDevPanel } from './components/ShaderDevPanel.js';

interface Params {
  camStyle: string;
  theme: string;
  debug: boolean;
  shaderDev: boolean;
  timeline: TimelineEvent[];
  targetFps: number;
  fallbackDuration: number;
  qualityPreset: string;
  videoUrl?: string;
  title?: string;
  subtitle?: string;
  ctaLink?: string;
  letterbox: boolean;
}

interface AggConfig {
  pulseMs: number;
  zoomBoost: number;
  cutExposureBoost: number;
  shakeAmp: number;
  shakeDecay: number;
}

function parseParams(): Params {
  const q = new URLSearchParams(location.search);
  const debug = q.get('debug') === '1';
  let camStyle = q.get('cam') || 'default';
  const timeline: TimelineEvent[] = [];
  try {
    const tl = q.get('timeline');
    if (tl) {
      const parsed = JSON.parse(atob(tl));
      if (parsed && parsed.serverTimeline) {
        // defer actual timeline fetch to runtime via global hook
        (window as any).__FETCH_TIMELINE__ = true;
      } else if (Array.isArray(parsed)) {
        timeline.push(...parsed);
      }
    }
  } catch {}
  if (camStyle === 'default' && timeline.length > 2 && !q.get('cam')) {
    camStyle = timeline.length > 6 ? 'aggressive' : 'cinematic';
  }

  const fallbackDuration = parseInt(q.get('fallbackDuration') || '8000', 10);
  console.log('[compositor] URL parameters:', {
    fallbackDuration,
    theme: q.get('theme'),
    cam: camStyle,
    debug,
  });

  return {
    camStyle,
    theme: q.get('theme') || 'sky',
    debug,
    shaderDev: q.get('shaderDev') === '1',
    timeline,
    targetFps: Math.max(1, parseInt(q.get('fps') || '30', 10)),
    fallbackDuration,
    qualityPreset: q.get('quality') || 'auto',
    videoUrl: q.get('video') || undefined,
    title: q.get('title') ? decodeURIComponent(q.get('title')!) : undefined,
    subtitle: q.get('subtitle') ? decodeURIComponent(q.get('subtitle')!) : undefined,
    ctaLink: q.get('link') || undefined,
    letterbox: q.get('letterbox') !== '0',
  };
}

const useAnimation = (cb: (t: number) => void) => {
  useEffect(() => {
    let frame: number;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      cb(t);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [cb]);
};

const CompositorApp: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const params = useRef(parseParams());
  const [ready, setReady] = useState(false);
  const [shaderState, setShaderState] = useState<ShaderState>({
    vert: '',
    frag: '',
    log: '',
    ok: false,
    loading: false,
  });
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const sceneRef = useRef<THREE.Scene>();
  const postSceneRef = useRef<THREE.Scene | null>(null);
  const postCamRef = useRef<THREE.OrthographicCamera | null>(null);
  const edgeMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const rtRef = useRef<THREE.WebGLRenderTarget>();
  const camKeysRef = useRef<any[]>([]);
  const startRef = useRef<number>(0);
  const smooth = useRef({ cx: 0.5, cy: 0.5, zoom: 1 });
  // Aggressive camera state
  const lastShotIndexRef = useRef<number>(-1);
  const cutTimeRef = useRef<number>(-1);
  const shotSeedRef = useRef<number>(0);
  const focusEventsRef = useRef<TimelineEvent[]>([]);
  const activeFocusRef = useRef<TimelineEvent | null>(null);
  const focusScaleRef = useRef<number>(1);
  const focusScaleTargetRef = useRef<number>(1);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recorderStartedRef = useRef<boolean>(false);
  const exposureRef = useRef<number>(1);
  const adaptiveRef = useRef({ accTime: 0, accFrames: 0, evalTimer: 0 });
  const CAMRef = useRef(buildCamConfig(params.current.camStyle));
  const AGGRef = useRef<AggConfig | null>(
    params.current.camStyle === 'aggressive'
      ? { pulseMs: 300, zoomBoost: 0.22, cutExposureBoost: 0.32, shakeAmp: 0.28, shakeDecay: 0.9 }
      : null
  );
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const dbg = useCallback((...a: any[]) => {
    if (params.current.debug) console.log('[dbg]', ...a);
  }, []);

  const upcoming = useCallback((ms: number) => {
    const focusEvents = focusEventsRef.current;
    for (const ev of focusEvents) {
      if (ms <= ev.t && ev.t - ms < 1600) return ev;
    }
    return null;
  }, []);
  const nextAfter = useCallback((t0: number) => {
    const focusEvents = focusEventsRef.current;
    for (const ev of focusEvents) {
      if (ev.t > t0) return ev;
    }
    return null;
  }, []);

  // Shader loading & dev diagnostics
  const loadShaders = useCallback(
    async (force: boolean) => {
      if (!params.current.shaderDev && edgeMatRef.current) return; // already loaded
      setShaderState((s: ShaderState) => ({ ...s, loading: true }));
      try {
        const [vert, frag] = await Promise.all([
          fetch('./shaders/edge.vert.glsl', { cache: force ? 'no-store' : 'default' }).then((r) =>
            r.text()
          ),
          fetch('./shaders/edge.frag.glsl', { cache: force ? 'no-store' : 'default' }).then((r) =>
            r.text()
          ),
        ]);
        setShaderState((prev: ShaderState) => ({ ...prev, vert, frag }));
        const rt = rtRef.current!;
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uBase: { value: rt.texture },
            uTexel: { value: new THREE.Vector2(1 / innerWidth, 1 / innerHeight) },
            uEdge: { value: 1 },
            uLift: { value: 0.18 },
            uBorder: { value: 0.6 },
          },
          vertexShader: vert,
          fragmentShader: frag,
        });
        edgeMatRef.current = mat;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        const pScene = new THREE.Scene();
        pScene.add(quad);
        postSceneRef.current = pScene;
        postCamRef.current = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        // compile to gather errors
        const compileErrors: string[] = [];
        const origErr = console.error;
        console.error = (...args: any[]) => {
          compileErrors.push(
            args.map((a) => (typeof a === 'string' ? a : a?.message || JSON.stringify(a))).join(' ')
          );
          origErr(...args);
        };
        try {
          rendererRef.current?.compile(pScene, postCamRef.current!);
        } catch (e: any) {
          compileErrors.push(e.message || String(e));
        }
        console.error = origErr;
        if (compileErrors.length) {
          setShaderState((s: ShaderState) => ({
            ...s,
            ok: false,
            log: compileErrors.join('\n'),
            loading: false,
          }));
        } else setShaderState((s: ShaderState) => ({ ...s, ok: true, log: '', loading: false }));
        dbg('shaders loaded');
      } catch (e: any) {
        setShaderState((s: ShaderState) => ({
          ...s,
          ok: false,
          log: 'Load failed: ' + (e.message || String(e)),
          loading: false,
        }));
        console.warn('shader load failed', e);
      }
    },
    [dbg]
  );

  // Recording logic
  const startRecording = useCallback(() => {
    if (recorderStartedRef.current) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const stream = renderer.domElement.captureStream(params.current.targetFps);
    let mime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    rec.ondataavailable = (e) => {
      if (e.data.size) recordingChunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      console.log('[compositor] Recording stopped, blob size:', recordingChunksRef.current.length);
      const blob = new Blob(recordingChunksRef.current, { type: 'video/webm' });
      console.log('[compositor] Final blob size:', blob.size, 'bytes');

      // Debug: Create a video element to check the actual duration of our recorded blob
      const testVideo = document.createElement('video');
      testVideo.src = URL.createObjectURL(blob);
      testVideo.onloadedmetadata = () => {
        const expected = (Math.max(params.current.fallbackDuration, 8000) + 1200) / 1000;
        console.log(
          '[compositor] RECORDED VIDEO DURATION:',
          testVideo.duration,
          'seconds (expected ~',
          expected,
          ')'
        );
      };
      let base64 = '';
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        console.log('[compositor] Converting blob to base64, size:', buf.length, 'bytes');
        const CH = 0x8000;
        let bin = '';
        for (let i = 0; i < buf.length; i += CH) {
          bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));
        }
        base64 = btoa(bin);
        console.log('[compositor] Base64 conversion complete, length:', base64.length);
      } catch (e) {
        console.error('[compositor] Base64 conversion failed:', e);
      }
      let cover = '';
      try {
        renderer.render(sceneRef.current!, cameraRef.current!);
        cover = renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
        console.log('[compositor] Cover image captured, length:', cover.length);
      } catch (e) {
        console.error('[compositor] Cover capture failed:', e);
      }
      console.log('[compositor] About to call nodeDone, exists:', typeof (window as any).nodeDone);
      try {
        if ((window as any).nodeDone) {
          const meta = JSON.stringify({
            recordedBlobBytes: blob.size,
            chunks: recordingChunksRef.current.length,
            expectedDurationMs: Math.max(params.current.fallbackDuration, 8000) + 1200,
            userAgent: navigator.userAgent,
          });
          console.log(
            '[compositor] Calling nodeDone with base64 length:',
            base64.length,
            'meta:',
            meta
          );
          await (window as any).nodeDone(base64, cover, meta);
          console.log('[compositor] nodeDone completed');
        } else {
          console.error('[compositor] nodeDone function not available!');
        }
      } catch (e) {
        console.error('[compositor] nodeDone failed:', e);
      }
      (window as any).COMPOSITOR_READY = true;
    };
    rec.start();
    recorderRef.current = rec;
    recorderStartedRef.current = true;

    // Ensure minimum recording duration - at least 8 seconds
    const minDuration = Math.max(params.current.fallbackDuration, 8000);
    const recordingDuration = minDuration + 1200;

    console.log(
      '[compositor] Recording started, will stop after:',
      recordingDuration,
      'ms (fallbackDuration:',
      params.current.fallbackDuration,
      'ms)'
    );
    setTimeout(() => {
      console.log('[compositor] Stopping recording due to timeout');
      if (rec.state === 'recording') rec.stop();
    }, recordingDuration);

    // Backup timeout to prevent infinite recording
    setTimeout(() => {
      console.log('[compositor] BACKUP: Force stopping recording after 15 seconds');
      if (rec.state === 'recording') rec.stop();
    }, 15000);
  }, []);

  useEffect(() => {
    const paramsVal = params.current;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    (window as any).__COMPOSITOR_RAN = true;
    const cam = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 200);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(new THREE.Color('#0a0f25'), 10, 60);
    mountRef.current!.appendChild(renderer.domElement);
    const resize = () => {
      renderer.setSize(innerWidth, innerHeight, false);
      cam.aspect = innerWidth / innerHeight;
      cam.updateProjectionMatrix();
      if (edgeMatRef.current)
        edgeMatRef.current.uniforms.uTexel.value.set(1 / innerWidth, 1 / innerHeight);
    };
    resize();
    addEventListener('resize', resize);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.4);
    dir.position.set(5, 10, 7);
    scene.add(dir);
    // Video plane & parallax
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    video.loop = true; // Loop the video to keep it playing
    videoElRef.current = video;
    const tex = new THREE.VideoTexture(video);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 9, 32, 18),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.02 })
    );
    plane.rotation.x = -Math.PI * 0.18;
    scene.add(plane);
    if (paramsVal.theme === 'teaser') {
      const parallax = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(16, 9),
          new THREE.MeshBasicMaterial({
            color: 0x0a162b,
            transparent: true,
            opacity: 0.04 + Math.random() * 0.05,
          })
        );
        m.position.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, -4 - i * 1.8);
        m.rotation.x = -Math.PI * 0.18 + (Math.random() - 0.5) * 0.05;
        m.rotation.y = (Math.random() - 0.5) * 0.3;
        parallax.add(m);
      }
      scene.add(parallax);
    }
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { depthBuffer: true });
    rtRef.current = rt;
    loadShaders(true);
    // set titles & letterbox
    if (paramsVal.title) {
      const el = document.getElementById('title');
      if (el) el.textContent = paramsVal.title;
    }
    if (paramsVal.subtitle) {
      const el = document.getElementById('subtitle');
      if (el) el.textContent = paramsVal.subtitle;
    }
    if (paramsVal.letterbox && paramsVal.theme === 'teaser') {
      ['lbTop', 'lbBottom', 'vignette', 'grain'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) (el as any).hidden = false;
      });
    }
    if (paramsVal.ctaLink) {
      const a = document.createElement('a');
      a.href = paramsVal.ctaLink;
      a.target = '_blank';
      a.textContent = new URL(paramsVal.ctaLink).host.replace(/^www\./, '');
      a.className = 'cta-link';
      document.body.appendChild(a);
    }
    // fetch video
    (async () => {
      if (!paramsVal.videoUrl) return;
      try {
        const r = await fetch(paramsVal.videoUrl, { cache: 'no-store' });
        const b = await r.blob();
        video.src = URL.createObjectURL(b);
        dbg('video blob', b.size);
      } catch (e) {
        video.src = paramsVal.videoUrl;
      }
    })();
    video.addEventListener('canplay', () => {
      dbg('video canplay', video.duration);
      console.log('[compositor] video can play, duration:', video.duration);
      console.log('[compositor] video.loop:', video.loop);
      video.play().catch((e) => {
        console.warn('[compositor] video play failed:', e);
      });
      setTimeout(() => startRecording(), paramsVal.theme === 'teaser' ? 400 : 0);
    });
    video.addEventListener('loadstart', () => {
      console.log('[compositor] video load started');
    });
    video.addEventListener('error', (e) => {
      console.error('[compositor] video error:', e);
    });
    video.addEventListener('loadeddata', () => {
      console.log('[compositor] video loaded data, duration:', video.duration);
    });
    video.addEventListener('ended', () => {
      console.log('[compositor] video ended (but should loop)');
    });
    setTimeout(() => {
      if (!recorderStartedRef.current) startRecording();
    }, 2500);
    setTimeout(() => {
      if (!(window as any).COMPOSITOR_READY) (window as any).COMPOSITOR_READY = true;
    }, paramsVal.fallbackDuration + 5000);

    // Remove the video 'ended' event handler that was stopping recording early
    // The recording should continue for the full fallbackDuration regardless of video length

    rendererRef.current = renderer;
    cameraRef.current = cam;
    sceneRef.current = scene;
    CAMRef.current = buildCamConfig(paramsVal.camStyle);
    camKeysRef.current = buildCamKeys(paramsVal.timeline, paramsVal.camStyle, CAMRef.current);
    focusEventsRef.current = paramsVal.timeline.filter((ev: TimelineEvent) =>
      ['click', 'type', 'prefocus', 'wait', 'press'].includes((ev as any).type)
    );
    // If timeline was deferred, fetch it now
    if ((window as any).__FETCH_TIMELINE__) {
      fetch('/timeline')
        .then((r) => r.json())
        .then((serverTl: any[]) => {
          params.current.timeline = serverTl;
          camKeysRef.current = buildCamKeys(
            serverTl as any,
            params.current.camStyle,
            CAMRef.current
          );
          focusEventsRef.current = serverTl.filter((ev: any) =>
            ['click', 'type', 'prefocus', 'wait', 'press'].includes(ev.type)
          );
          setReady(true);
        })
        .catch((e) => {
          console.warn('[compositor] failed fetching /timeline', e);
          setReady(true);
        });
    } else {
      setReady(true);
    }

    // Signal compositor ready early for basic functionality
    console.log('[compositor] Scene initialized, signaling ready');
    (window as any).COMPOSITOR_READY = true;

    return () => {
      removeEventListener('resize', resize);
    };
  }, [dbg, loadShaders, startRecording]);

  useAnimation((t) => {
    if (!ready) return;
    if (!startRef.current) startRef.current = t;
    const rel = t - startRef.current;
    const p = params.current;
    const renderer = rendererRef.current!,
      cam = cameraRef.current!,
      scene = sceneRef.current!;
    const CAM = CAMRef.current;
    const AGG = AGGRef.current;
    const camKeys = camKeysRef.current;
    // adaptive frame scale
    const ad = adaptiveRef.current;
    const now = performance.now();
    ad.accFrames++;
    ad.accTime += 1000 / 60;
    ad.evalTimer += 1000 / 60; // rough estimate; could compute dt precisely
    if (ad.evalTimer > 1000 && ad.accFrames > 5) {
      const avg = ad.accTime / ad.accFrames;
      const minScale = p.qualityPreset === 'max' ? 1 : p.qualityPreset === 'high' ? 0.85 : 0.6;
      if (!(renderer as any).__scale) (renderer as any).__scale = 1;
      if (p.qualityPreset !== 'max') {
        if (avg > (1000 / p.targetFps) * 1.4 && (renderer as any).__scale > minScale)
          (renderer as any).__scale = Math.max(minScale, (renderer as any).__scale - 0.05);
        else if (avg < (1000 / p.targetFps) * 0.9 && (renderer as any).__scale < 1)
          (renderer as any).__scale = Math.min(1, (renderer as any).__scale + 0.05);
      }
      renderer.setSize(
        innerWidth * (renderer as any).__scale,
        innerHeight * (renderer as any).__scale,
        false
      );
      renderer.domElement.style.width = innerWidth + 'px';
      renderer.domElement.style.height = innerHeight + 'px';
      ad.accTime = 0;
      ad.accFrames = 0;
      ad.evalTimer = 0;
    }

    const raw = sampleCamera(camKeys, p.camStyle, rel, CAM);
    if (p.camStyle === 'aggressive' && AGG) {
      // shot index
      let shotIndex = 0;
      for (let i = 0; i < camKeys.length; i++) {
        if (rel >= camKeys[i].t) shotIndex = i;
        else break;
      }
      if (shotIndex !== lastShotIndexRef.current) {
        lastShotIndexRef.current = shotIndex;
        cutTimeRef.current = rel;
        shotSeedRef.current = Math.random() * 1000;
      }
      const cutAge = cutTimeRef.current >= 0 ? rel - cutTimeRef.current : 1e9;
      const dxRaw = raw.cx - smooth.current.cx,
        dyRaw = raw.cy - smooth.current.cy;
      const lerp = cutAge < 80 ? 1 : CAM.posLerp;
      if (Math.hypot(dxRaw, dyRaw) > (cutAge < 80 ? 0 : CAM.movementDeadZone)) {
        smooth.current.cx += dxRaw * lerp;
        smooth.current.cy += dyRaw * lerp;
      }
      const pulseK = cutAge < AGG.pulseMs ? Math.max(0, 1 - Math.pow(cutAge / AGG.pulseMs, 2)) : 0;
      const targetZoom = raw.zoom * (1 + AGG.zoomBoost * pulseK);
      smooth.current.zoom += (targetZoom - smooth.current.zoom) * (cutAge < 80 ? 1 : CAM.zoomLerp);
      // focus upcoming
      const up = upcoming(rel + 420);
      if (up && (!activeFocusRef.current || up.t !== activeFocusRef.current.t)) {
        activeFocusRef.current = { ...up } as any;
        if ((up as any).w && (up as any).h) {
          const desired = 0.82;
          const sw = desired / Math.max(0.001, (up as any).w);
          const sh = desired / Math.max(0.001, (up as any).h);
          focusScaleTargetRef.current = Math.min(Math.max(sw, sh), 3.8);
        } else focusScaleTargetRef.current = up.type === 'type' ? 2.2 : 1.65;
      }
      if (activeFocusRef.current && rel - activeFocusRef.current.t > 1200) {
        activeFocusRef.current = null;
        focusScaleTargetRef.current = 1;
      }
      focusScaleRef.current += (focusScaleTargetRef.current - focusScaleRef.current) * 0.34;
      if (Math.abs(focusScaleRef.current - focusScaleTargetRef.current) < 0.01)
        focusScaleRef.current = focusScaleTargetRef.current;
      let camCx = smooth.current.cx,
        camCy = smooth.current.cy;
      if (activeFocusRef.current && activeFocusRef.current.type === 'type') {
        const dwell = 240;
        const nxt = nextAfter(activeFocusRef.current.t);
        const panStart = activeFocusRef.current.t + dwell;
        if (nxt) {
          const panEnd = Math.min(nxt.t - CAM.leadMs, panStart + 900);
          if (rel >= panStart && rel < panEnd) {
            const kr = (rel - panStart) / Math.max(1, panEnd - panStart);
            const ease = kr < 0.5 ? 4 * kr * kr * kr : 1 - Math.pow(-2 * kr + 2, 3) / 2;
            if ((activeFocusRef.current as any).x != null && (nxt as any).x != null)
              camCx =
                (activeFocusRef.current as any).x +
                ((nxt as any).x - (activeFocusRef.current as any).x) * ease * 0.85;
            if ((activeFocusRef.current as any).y != null && (nxt as any).y != null)
              camCy =
                (activeFocusRef.current as any).y +
                ((nxt as any).y - (activeFocusRef.current as any).y) * ease * 0.85;
          }
        }
      }
      const fx =
        (camCx - 0.5) * 16 +
        (cutAge < 220
          ? Math.sin(shotSeedRef.current + rel * 0.025) * AGG.shakeAmp * (1 - cutAge / 220)
          : 0);
      const fy =
        (0.5 - camCy) * 9 +
        (cutAge < 220
          ? Math.cos(shotSeedRef.current * 0.7 + rel * 0.03) *
            AGG.shakeAmp *
            (1 - cutAge / 220) *
            0.6
          : 0);
      const baseZ =
        (26 - Math.min(1, rel / 1000 / CAM.settleSeconds) * CAM.idlePushInZ) /
        focusScaleRef.current;
      if (p.theme === 'teaser') {
        cam.position.set(fx * 0.25, 9 + fy * 0.12, baseZ);
        cam.rotation.z = Math.sin(shotSeedRef.current + rel * 0.002) * 0.02 + fx * 0.002;
        cam.lookAt(fx * 0.35, 1.5 + fy * 0.2, 0);
      } else {
        cam.position.set(fx * 0.15, 7.5 + fy * 0.1, baseZ + 2);
        cam.lookAt(fx * 0.3, fy * 0.18, 0);
      }
      if (raw.cut) exposureRef.current = CAM.exposureCut + AGG.cutExposureBoost;
      else if (!lastShotIndexRef.current || rel - cutTimeRef.current > AGG.pulseMs)
        exposureRef.current += (1 - exposureRef.current) * CAM.exposureLerp * 0.5;
    } else {
      const dx = raw.cx - smooth.current.cx,
        dy = raw.cy - smooth.current.cy;
      if (Math.hypot(dx, dy) > CAM.movementDeadZone) {
        smooth.current.cx += dx * CAM.posLerp;
        smooth.current.cy += dy * CAM.posLerp;
      }
      smooth.current.zoom += (raw.zoom - smooth.current.zoom) * CAM.zoomLerp;
      exposureRef.current += (1 - exposureRef.current) * CAM.exposureLerp;
      cam.position.set(
        Math.sin(rel * 0.00025) * 6,
        8 + Math.sin(rel * 0.0003) * 1.2,
        22 - (rel / 1000) * 1.2
      );
      cam.lookAt(0, 0, 0);
    }
    renderer.toneMappingExposure = exposureRef.current;
    const postScene = postSceneRef.current;
    const postCam = postCamRef.current;
    if (postScene && postCam) {
      renderer.setRenderTarget(rtRef.current!);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } else renderer.render(scene, cam);
  });

  // Expose minimal shaderDev API
  useEffect(() => {
    (window as any).shaderDev = { reload: () => loadShaders(true), state: shaderState };
  }, [shaderState, loadShaders]);

  return (
    <>
      <div ref={mountRef} style={{ position: 'fixed', inset: 0 as any }} />
      {params.current.shaderDev && (
        <ShaderDevPanel shaderState={shaderState} onReload={() => loadShaders(true)} />
      )}
    </>
  );
};

createRoot(document.getElementById('root')!).render(<CompositorApp />);

// Signal that the module has loaded
if (typeof (window as any).__COMPOSITOR_MODULE_LOADED === 'function') {
  (window as any).__COMPOSITOR_MODULE_LOADED();
}
