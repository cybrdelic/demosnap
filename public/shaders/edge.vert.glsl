// Edge post-process vertex shader
// Extracted for readability & syntax highlighting.
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
