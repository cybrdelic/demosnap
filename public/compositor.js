import * as THREE from 'three';

const params = new URLSearchParams(location.search);
const videoUrl = params.get('video');
const title = decodeURIComponent(params.get('title')||'');
const subtitle = decodeURIComponent(params.get('subtitle')||'');
const theme = params.get('theme') || 'sky';

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
if (titleEl) titleEl.textContent = title;
if (subtitleEl) subtitleEl.textContent = subtitle;
const originEl = document.getElementById('origin');
if (originEl) originEl.textContent = window.location.host;

const scene = new THREE.Scene();
const fogColor = new THREE.Color('#0a0f25');
scene.fog = new THREE.Fog(fogColor, 10, 60);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dir = new THREE.DirectionalLight(0xffffff, 0.4); dir.position.set(5,10,7); scene.add(dir);

// Sky dome
if (theme === 'sky') {
  const skyGeo = new THREE.SphereGeometry(120, 32, 16);
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x1e2958, side: THREE.BackSide });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);
}

// Subtle grid plane
const grid = new THREE.GridHelper(120, 60, 0x335577, 0x223344);
(grid.material as any).opacity = 0.2;
(grid.material as any).transparent = true;
scene.add(grid);

// Video texture plane
const video = document.createElement('video');
video.src = videoUrl || '';
video.crossOrigin = 'anonymous';
video.playsInline = true;
video.muted = true; // autoplay needs mute
video.loop = false;
video.preload = 'auto';

const tex = new THREE.VideoTexture(video);
tex.minFilter = THREE.LinearFilter;
tex.magFilter = THREE.LinearFilter;
tex.anisotropy = 4;

const planeGeometry = new THREE.PlaneGeometry(16, 9);
const planeMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.02 });
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
plane.rotation.x = -Math.PI * 0.2;
scene.add(plane);

camera.position.set(0, 8, 22);

let startTime = 0;
let recordingChunks = [] as BlobPart[];
let recorder: MediaRecorder | null = null;
let coverCaptured = false;

function startRecording() {
  const stream = renderer.domElement.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  recorder.ondataavailable = e => { if (e.data.size) recordingChunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(recordingChunks, { type: 'video/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    // cover frame
    const cover = renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    // @ts-ignore
    await window.nodeDone(base64, cover);
    // @ts-ignore
    window.COMPOSITOR_READY = true;
  };
  recorder.start();
}

function animate(t: number) {
  requestAnimationFrame(animate);
  if (!startTime) startTime = t;
  const elapsed = (t - startTime) / 1000;
  // Dolly path
  camera.position.x = Math.sin(elapsed * 0.25) * 6;
  camera.position.y = 8 + Math.sin(elapsed * 0.3) * 1.2;
  camera.position.z = 22 - elapsed * 1.2; // slow push in
  camera.lookAt(0,0,0);

  plane.rotation.y = Math.sin(elapsed * 0.4) * 0.15;

  if (video.readyState >= 2 && video.currentTime > 0) {
    if (!coverCaptured && video.currentTime > 0.5) {
      coverCaptured = true; // already captured via recorder stop
    }
    if (video.ended) {
      if (recorder && recorder.state === 'recording') recorder.stop();
    }
  }
  renderer.render(scene, camera);
}

video.addEventListener('canplay', () => {
  video.play();
  startRecording();
});

video.addEventListener('ended', () => {
  if (recorder && recorder.state === 'recording') recorder.stop();
});

animate(0);
