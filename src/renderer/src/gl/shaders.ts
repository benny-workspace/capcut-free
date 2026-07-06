// Shared GLSL for the compositor. One program, three modes:
//   0 = layer composite (color adjust -> chroma key -> mask -> opacity)
//   1 = adjustment pass (full-frame color adjust mixed by opacity)
//   2 = passthrough blit

export const VERT = `#version 300 es
layout(location=0) in vec2 aPos;      // unit quad, (0,0) = top-left
uniform vec2 uCanvas;                 // output size, px
uniform vec4 uRect;                   // layer rect x,y,w,h in canvas px (y-down)
uniform float uRot;                   // radians
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 center = uRect.xy + uRect.zw * 0.5;
  vec2 p = (aPos - 0.5) * uRect.zw;
  float c = cos(uRot), s = sin(uRot);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + center;
  vec2 clip = (p / uCanvas) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

export const FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uMode;
uniform float uOpacity;
uniform int uUseColor;
uniform vec4 uColorAdj;               // exposure, contrast, saturation, temperature
uniform int uChromaOn;
uniform vec3 uKeyColor;
uniform vec3 uChroma;                 // similarity, smoothness, spill
uniform int uMaskType;                // 0 none, 1 rect, 2 ellipse, 3 linear
uniform vec4 uMaskRect;               // cx, cy, w, h in layer uv
uniform vec3 uMaskExtra;              // feather, rotation(rad), invert(0/1)
out vec4 outColor;

vec2 cc(vec3 rgb) {
  float y = dot(rgb, vec3(0.299, 0.587, 0.114));
  return vec2(rgb.b - y, rgb.r - y);
}

vec3 applyColor(vec3 rgb) {
  rgb += uColorAdj.x * 0.25;
  rgb = (rgb - 0.5) * (1.0 + uColorAdj.y) + 0.5;
  float l = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(l), rgb, max(0.0, 1.0 + uColorAdj.z));
  float t = uColorAdj.w;
  rgb *= vec3(1.0 + 0.16 * t, 1.0 + 0.04 * t, 1.0 - 0.16 * t);
  return rgb;
}

void main() {
  vec4 c = texture(uTex, vUv);

  if (uMode == 2) { outColor = c; return; }

  if (uMode == 1) {
    outColor = vec4(mix(c.rgb, clamp(applyColor(c.rgb), 0.0, 1.0), uOpacity), c.a);
    return;
  }

  if (uChromaOn == 1) {
    float d = distance(cc(c.rgb), cc(uKeyColor));
    float a = smoothstep(uChroma.x, uChroma.x + uChroma.y + 1e-5, d);
    float spillZone = 1.0 - smoothstep(uChroma.x, uChroma.x * 2.0 + uChroma.y + 1e-5, d);
    float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    c.rgb = mix(c.rgb, vec3(luma), spillZone * uChroma.z);
    c.a *= a;
  }

  if (uUseColor == 1) c.rgb = clamp(applyColor(c.rgb), 0.0, 1.0);

  if (uMaskType > 0) {
    vec2 p = vUv - uMaskRect.xy;
    float cr = cos(-uMaskExtra.y), sr = sin(-uMaskExtra.y);
    p = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr);
    float fe = max(uMaskExtra.x, 1e-4);
    float m = 1.0;
    if (uMaskType == 1) {
      vec2 d2 = abs(p) - uMaskRect.zw * 0.5;
      m = 1.0 - smoothstep(-fe * 0.5, fe * 0.5, max(d2.x, d2.y));
    } else if (uMaskType == 2) {
      float d = length(p / (uMaskRect.zw * 0.5)) - 1.0;
      m = 1.0 - smoothstep(-fe, fe, d * 0.5);
    } else {
      m = 1.0 - smoothstep(-fe * 0.5, fe * 0.5, p.y);
    }
    if (uMaskExtra.z > 0.5) m = 1.0 - m;
    c.a *= m;
  }

  outColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0) * uOpacity);
}`
