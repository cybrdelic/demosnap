// Edge detection + lifted contrast fragment shader
// Performs Sobel edge detection, mixes an edge lift with base color, adds subtle border falloff.
precision highp float;
uniform sampler2D uBase;
uniform vec2 uTexel;
uniform float uEdge;
uniform float uLift;
uniform float uBorder;
varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 t = uTexel;
  float tl = luma(texture2D(uBase, vUv + vec2(-t.x,-t.y)).rgb);
  float l  = luma(texture2D(uBase, vUv + vec2(-t.x, 0.0)).rgb);
  float bl = luma(texture2D(uBase, vUv + vec2(-t.x, t.y)).rgb);
  float t0 = luma(texture2D(uBase, vUv + vec2( 0.0,-t.y)).rgb);
  float c  = luma(texture2D(uBase, vUv).rgb);
  float b  = luma(texture2D(uBase, vUv + vec2( 0.0, t.y)).rgb);
  float tr = luma(texture2D(uBase, vUv + vec2( t.x,-t.y)).rgb);
  float r  = luma(texture2D(uBase, vUv + vec2( t.x, 0.0)).rgb);
  float br = luma(texture2D(uBase, vUv + vec2( t.x, t.y)).rgb);

  float gx = (tr + 2.0*r + br) - (tl + 2.0*l + bl);
  float gy = (bl + 2.0*b + br) - (tl + 2.0*t0 + tr);
  float edge = clamp(sqrt(gx*gx + gy*gy) * uEdge, 0.0, 1.0);

  vec2 d = abs(vUv - 0.5) * 2.0;
  float border = pow(max(d.x, d.y), 1.5);
  float lift = uLift * mix(1.0, border, uBorder);

  vec3 base = texture2D(uBase, vUv).rgb;
  gl_FragColor = vec4(base + edge * lift, 1.0);
}
