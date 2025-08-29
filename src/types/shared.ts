// Shared types used by both server and client
export interface TimelineEvent {
  t: number;
  type: 'click' | 'type' | 'prefocus' | 'wait' | 'press' | string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface CamKey {
  t: number;
  cx: number;
  cy: number;
  zoom: number;
  cut: boolean;
}

export interface CamConfig {
  leadMs: number;
  clusterMs: number;
  maxZoom: number;
  posLerp: number;
  zoomLerp: number;
  movementDeadZone: number;
  exposureCut: number;
  exposureLerp: number;
  settleSeconds: number;
  idleDriftAmp: number;
  idlePushInZ: number;
  dedupeDist: number;
  dedupeZoomDelta: number;
  cutMoveThreshold: number;
  cutZoomThreshold: number;
}

export interface ShaderState {
  vert: string;
  frag: string;
  log: string;
  ok: boolean;
  loading: boolean;
}
