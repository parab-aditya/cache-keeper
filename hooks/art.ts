// Desktop band art for cache-keeper. Pure module: strings and constants only, no `$`, no engine imports.
//
// Techniques adapted from HeyCubit/effortless (MIT, Copyright (c) 2026 HeyCubit, hooks/register.tsx): the
// `inPhase` phase-lock, the rim glow (blurred halo + crisp inner line), the art recipe (left-transparent
// gradient + fade mask + grain + sparse particles with staggered CSS keyframes), the 8-tooth cog and the cache clock.
//
// How the band uses it: `artLayers(state, { light, nowMs })` returns Svg layers drawn behind the Text/Buttons,
// in order. 'right' layers are 440x64, bottom-right anchored art ("xMaxYMid slice") that fades out over the left
// ~45% so the text stays readable; give them an absolute Box `top={-1} bottom={-1} right={0}` so the band
// (overflow hidden) clips them. 'full' layers are 760x37, stretched over the whole band ("none").
// Every source is constant per state + theme + `nowMs`: the cold art and the overlays take one `inPhase` style at the end,
// the ember art (warm, refreshing, cooling) gives each element its own negative delay computed from `nowMs`, so a redraw
// that restarts the <img> still shows every loop at the right phase. Use a fresh `nowMs` ($.clock.now()) per draw.
// Also here: the toggle, the cog, the status dot, the savings hero and the self-ticking countdown (`clockSvg`, from
// effortless's `cacheClockSvg`): one <text> per minute shown by a step-end animation, so the band needs no redraw.
//
// Rules the art keeps (effortless's notes): < 20 000 chars each, width/height on the root, no clipPath, no
// script or event attributes, CSS keyframes only, strokes on stretched layers use non-scaling-stroke.

export type ArtState = 'warm' | 'refreshing' | 'off' | 'cooling' | 'error' | 'cold' | 'dim'
export type ArtTheme = 'dark' | 'light'
export type ArtColors = { bg: string; edge: string; accent: string; text: string; dim: string }
export type ArtLayer = { key: string; svg: string; width: number; height: number; anchor: 'right' | 'full' }

export const ART_STATES: readonly ArtState[] = ['warm', 'refreshing', 'off', 'cooling', 'error', 'cold', 'dim']
export const ART_RIGHT = { width: 440, height: 64 } as const
export const ART_FULL = { width: 760, height: 37 } as const

/** Box backgroundColor / borderColor and Text colours. The band picks `dark` or `light` (no theme API in Svg).
 * warm / refreshing are ember orange, off a neutral grey, cooling an amber-red alert (its text the warning colour),
 * error a rose, cold the ice the person liked, dim a still grey. */
export const PALETTE: Record<ArtTheme, Record<ArtState, ArtColors>> = {
  dark: {
    warm: { bg: '#1c120c', edge: '#6b3b1d', accent: '#f39a52', text: '#f4e4d6', dim: '#cbb29c' },
    refreshing: { bg: '#20140a', edge: '#8a5524', accent: '#ffbd5a', text: '#fff0dc', dim: '#dcc7a6' },
    off: { bg: '#151414', edge: '#2e2a28', accent: '#8d8782', text: '#d6d2ce', dim: '#8d8782' },
    cooling: { bg: '#1d1010', edge: '#8a3a24', accent: '#f27a4a', text: '#ffcc80', dim: '#c79a80' },
    error: { bg: '#1d0f14', edge: '#8a2640', accent: '#ff6b88', text: '#ffd5dd', dim: '#c493a0' },
    cold: { bg: '#0e1820', edge: '#2f5c80', accent: '#7cc4ff', text: '#dcebf7', dim: '#8da8bd' },
    dim: { bg: '#141416', edge: '#2a2a2f', accent: '#8b8b93', text: '#d4d4d8', dim: '#8b8b93' },
  },
  light: {
    warm: { bg: '#fdf0e4', edge: '#e8bf96', accent: '#b04f08', text: '#3a1f0a', dim: '#654529' },
    refreshing: { bg: '#fcebd4', edge: '#e5b06c', accent: '#a14a00', text: '#3a1c04', dim: '#654220' },
    off: { bg: '#f3f1ef', edge: '#d9d4cf', accent: '#6e6862', text: '#2a2724', dim: '#625b55' },
    cooling: { bg: '#fdebe3', edge: '#e2a387', accent: '#b8431a', text: '#6b2b0a', dim: '#74432f' },
    error: { bg: '#fdeaee', edge: '#e5a3b3', accent: '#be123c', text: '#4a0f1e', dim: '#703946' },
    cold: { bg: '#e8f2fb', edge: '#a9c9e4', accent: '#1f6fb2', text: '#14293a', dim: '#4c6a84' },
    dim: { bg: '#f2f2f4', edge: '#d4d4da', accent: '#6b6b75', text: '#2a2a30', dim: '#686870' },
  },
}

/** Art colours per state and theme: three gradient stops with their alphas, the radial's alpha, particles,
 * grain, and the rim line / halo. Light mode uses deeper inks because white glints vanish on a pale band. */
type Ink = { c: [string, string, string]; a: [number, number, number]; glow: number; spark: string; grain: string; grainA: number; rim: string; haloA: number }
const INK: Record<ArtTheme, Record<ArtState, Ink>> = {
  dark: {
    warm: { c: ['#c2410c', '#ea7a2a', '#ffb35c'], a: [0.08, 0.2, 0.31], glow: 0.19, spark: '#ffcf8a', grain: '#fff', grainA: 0.05, rim: '#f39a52', haloA: 0.18 },
    refreshing: { c: ['#d9780f', '#f5a524', '#ffd27a'], a: [0.12, 0.26, 0.4], glow: 0.22, spark: '#fff1c2', grain: '#fff', grainA: 0.06, rim: '#ffc266', haloA: 0.22 },
    off: { c: ['#8b8580', '#8b8580', '#a39d98'], a: [0.02, 0.04, 0.07], glow: 0.07, spark: '#a39d98', grain: '#fff', grainA: 0.04, rim: '#8d8782', haloA: 0 },
    cooling: { c: ['#b45309', '#c2410c', '#5b8bd6'], a: [0.1, 0.22, 0.3], glow: 0.18, spark: '#ffb08a', grain: '#fff', grainA: 0.05, rim: '#f27a4a', haloA: 0.22 },
    error: { c: ['#9f1239', '#e11d48', '#fb7185'], a: [0.1, 0.22, 0.32], glow: 0.16, spark: '#ffb3c1', grain: '#fff', grainA: 0.05, rim: '#ff6b88', haloA: 0.2 },
    cold: { c: ['#5aa9e6', '#8fd0ff', '#cdeaff'], a: [0.12, 0.28, 0.42], glow: 0.22, spark: '#fff', grain: '#fff', grainA: 0.07, rim: '#cfeeff', haloA: 0.16 },
    dim: { c: ['#8b8b93', '#8b8b93', '#a0a0a8'], a: [0.03, 0.06, 0.09], glow: 0.05, spark: '#a0a0a8', grain: '#fff', grainA: 0.05, rim: '#8b8b93', haloA: 0 },
  },
  light: {
    warm: { c: ['#ea7a2a', '#e0661a', '#c2540a'], a: [0.08, 0.17, 0.26], glow: 0.14, spark: '#b45309', grain: '#000', grainA: 0.04, rim: '#b45309', haloA: 0.16 },
    refreshing: { c: ['#f0a030', '#e08a10', '#c26a00'], a: [0.1, 0.22, 0.32], glow: 0.18, spark: '#a14a00', grain: '#000', grainA: 0.05, rim: '#a14a00', haloA: 0.18 },
    off: { c: ['#6e6862', '#6e6862', '#59534e'], a: [0.02, 0.04, 0.06], glow: 0.06, spark: '#6e6862', grain: '#000', grainA: 0.04, rim: '#6e6862', haloA: 0 },
    cooling: { c: ['#d97706', '#c2410c', '#3b6fc4'], a: [0.1, 0.2, 0.28], glow: 0.16, spark: '#b8431a', grain: '#000', grainA: 0.05, rim: '#b8431a', haloA: 0.18 },
    error: { c: ['#be123c', '#e11d48', '#be185d'], a: [0.08, 0.18, 0.28], glow: 0.14, spark: '#be123c', grain: '#000', grainA: 0.05, rim: '#be123c', haloA: 0.16 },
    cold: { c: ['#5aa9e6', '#4a93d4', '#2b7bbd'], a: [0.1, 0.2, 0.3], glow: 0.18, spark: '#2b7bbd', grain: '#000', grainA: 0.05, rim: '#2b7bbd', haloA: 0.16 },
    dim: { c: ['#6b6b75', '#6b6b75', '#55555f'], a: [0.03, 0.05, 0.07], glow: 0.04, spark: '#6b6b75', grain: '#000', grainA: 0.04, rim: '#6b6b75', haloA: 0 },
  },
}

const NS = 'xmlns="http://www.w3.org/2000/svg"'
const n1 = (x: number) => String(Math.round(x * 10) / 10)

/** Phase-locks every looping animation in `svg` to `elapsedMs`. The app swaps the band tree on every redraw and a
 * fresh image restarts its CSS animations; a negative delay puts them back where they were. Adapted from
 * effortless's `inPhase`, except the delay is `calc(var(--o) - elapsed)`: an element that carries its own
 * stagger as `style="--o:-4s"` keeps it, so one image can hold several staggered loops. */
export function inPhase(svg: string, elapsedMs: number): string {
  const s = (Math.max(0, elapsedMs) / 1000).toFixed(3)
  return svg.replace('</svg>', `<style>svg *{animation-delay:calc(var(--o,0s) - ${s}s) !important}</style></svg>`)
}

// ---------- right-anchored art (440x64, viewBox 440x64, bottom-right anchored) ----------

const W = ART_RIGHT.width
const H = ART_RIGHT.height
const MID = H / 2 // the band shows the middle ~37px of the 64px art box

/** A branching frost line from (x, y) at `deg`, `len` long; side branches at 55% along. */
function branch(x: number, y: number, deg: number, len: number, depth: number): string {
  const r = (deg * Math.PI) / 180
  const ex = x + len * Math.cos(r)
  const ey = y + len * Math.sin(r)
  let d = `M${n1(x)} ${n1(y)}L${n1(ex)} ${n1(ey)}`
  if (depth > 0) {
    const bx = x + len * 0.55 * Math.cos(r)
    const by = y + len * 0.55 * Math.sin(r)
    d += branch(bx, by, deg - 45, len * 0.45, depth - 1) + branch(bx, by, deg + 45, len * 0.45, depth - 1)
  }
  return d
}

/** A six-armed snowflake, each arm with two side twigs. */
function flake(cx: number, cy: number, r: number): string {
  let d = ''
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2
    const pt = (f: number, off: number, side: number) => {
      const aa = a + side * off
      return `${n1(cx + f * Math.cos(aa))} ${n1(cy + f * Math.sin(aa))}`
    }
    const tip = `${n1(cx + r * Math.cos(a))} ${n1(cy + r * Math.sin(a))}`
    d += `M${n1(cx)} ${n1(cy)}L${tip}`
    for (const f of [0.5, 0.78]) {
      for (const side of [-1, 1]) {
        const base = `${n1(cx + r * f * Math.cos(a))} ${n1(cy + r * f * Math.sin(a))}`
        d += `M${base}L${pt(r * f + r * 0.22, 0.75 - f * 0.4, side)}`
      }
    }
  }
  return d
}

/** The window the cold flakes and glints live in, in art x. The 440 px art is right-anchored, so on a 760 px band art x
 * maps to band x - 320: the button cluster (~230 px) starts at about art x 210 and the shortened cold text ends before
 * about art x 125, which leaves this ~85 px strip visible between them (a wider band only adds room to its left). */
export const COLD_MIN_X = 125
export const COLD_MAX_X = 210

/** The left-fade mask: transparent up to `from`, opaque from `to` (fractions of the 440 px width). */
const fade = (from: string, to: string) =>
  `<linearGradient id="fade" x1="0" x2="1"><stop offset="${from}" stop-color="#fff" stop-opacity="0"/><stop offset="${to}" stop-color="#fff" stop-opacity="1"/></linearGradient><mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>`

const motes = (pts: [number, number, number, number][], color: string) =>
  pts.map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${o}"/>`).join('')

const rings = (color: string, o: number) =>
  [58, 92, 126].map((r, i) => `<circle cx="478" cy="${MID}" r="${r}" fill="none" stroke="${color}" stroke-opacity="${n1(o - i * 0.03)}" stroke-width="1"/>`).join('')

/** The ember an off band keeps glowing faintly (static). */
const OFF_EMBER: Record<ArtTheme, string> = { dark: '#f39a52', light: '#c2540a' }

/** A negative `animation-delay` that puts an element with a `period`-second loop (and its own `offset`) where it would be
 * `nowMs` after the page started: every loop in the ember art is locked to the clock by its own delay, because a redraw
 * restarts a CSS animation and `inPhase` would give all of an image's elements the same delay. */
const lag = (nowMs: number, period: number, offset = 0): string => (-((nowMs / 1000 + offset) % period)).toFixed(3)

/** Embers: x, y, radius, rise period (s), stagger offset (s), sideways drift (px). Each rises 40 px, fading in and out. */
type Ember = readonly [x: number, y: number, r: number, period: number, offset: number, dx: number]
const EMBERS: readonly Ember[] = [
  [262, 54, 1.3, 7.5, 0, -6], [296, 56, 1.0, 9, 2.2, 5], [330, 55, 1.5, 6.5, 4.1, -4], [362, 57, 1.1, 8.5, 1.3, 6],
  [392, 54, 1.4, 7, 5.6, -5], [418, 56, 1.0, 9.5, 3.2, 4], [346, 58, 0.9, 8, 6.4, 3], [280, 56, 1.2, 10, 7.4, -3],
]
/** `speed` shortens every loop (refreshing), `size` grows them. Cooling embers sink instead (`sink` px). */
function embers(nowMs: number, color: string, o: { n?: number; speed?: number; size?: number; sink?: number } = {}): string {
  const { n = EMBERS.length, speed = 1, size = 1, sink } = o
  return EMBERS.slice(0, n)
    .map(([x, y, r, p, off, dx]) => {
      const per = p / speed
      return `<circle class="e" cx="${x}" cy="${y}" r="${n1(r * size)}" fill="${color}" style="animation:${sink === undefined ? 'up' : 'sink'} ${n1(per)}s linear ${lag(nowMs, per, off)}s infinite;--x:${dx}px${sink === undefined ? '' : `;--y:${sink}px`}"/>`
    })
    .join('')
}
const EMBER_CSS =
  '.e{opacity:0}@keyframes up{0%{transform:translate(0,0);opacity:0}12%{opacity:.9}65%{opacity:.45}100%{transform:translate(var(--x,0px),-40px);opacity:0}}' +
  '@keyframes sink{0%{transform:translate(0,0);opacity:0}15%{opacity:.8}100%{transform:translate(var(--x,0px),var(--y,16px));opacity:0}}'
const BREATHE = (lo: number) => `@keyframes br{0%,100%{opacity:${lo}}50%{opacity:1}}`

/** The sheet's art is a corner glow: it also fades out toward its bottom edge (the band's own art is clipped by the band instead). */
const VFADE = `<linearGradient id="vf" x1="0" x2="0" y1="0" y2="1"><stop offset=".4" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m2"><rect width="${W}" height="${H}" fill="url(#vf)"/></mask>`

/** The art recipe: tinted gradient from the right, radial bloom, grain, then per-state extras, all under the fade mask.
 * Ember states (warm, refreshing, cooling, error) lock their loops to `nowMs` themselves; cold uses `--o` + `inPhase`. */
function rightArt(state: ArtState, theme: ArtTheme, strip: boolean, nowMs: number, fadeDown = false): string {
  const k = INK[theme][state]
  const [c1, c2, c3] = k.c
  let css = 'svg{background:transparent;display:block}'
  let extra = ''
  let defs = ''
  // How the heat gradient and bloom breathe: inline, with the phase-locked delay.
  let br = ''
  if (state === 'warm') {
    // A soft heat glow breathing on an 8 s loop, 8 embers rising and fading on 6.5-10 s loops, the left clear.
    css += BREATHE(0.78) + EMBER_CSS
    br = ` style="animation:br 8s ease-in-out ${lag(nowMs, 8)}s infinite"`
    extra = rings(k.rim, 0.1) + embers(nowMs, k.spark, { size: 1.35 })
  } else if (state === 'refreshing') {
    // The same palette brighter, embers faster and larger; the golden flare is the sweep overlay (1.6 s).
    css += EMBER_CSS
    extra = rings(k.rim, 0.2) + embers(nowMs, k.spark, { speed: 2.2, size: 1.25 })
  } else if (state === 'off') {
    // No motion: a faint ember glow at rest.
    extra = ''
  } else if (state === 'cooling') {
    css += BREATHE(0.45) + EMBER_CSS
    br = ` style="animation:br 2s ease-in-out ${lag(nowMs, 2)}s infinite"`
    extra = embers(nowMs, k.spark, { n: 4, size: 1.1, sink: 18 })
  } else if (state === 'error') {
    css += BREATHE(0.5)
    br = ` style="animation:br 3s ease-in-out ${lag(nowMs, 3)}s infinite"`
    extra = motes([[300, 40, 0.9, 0.35], [344, 24, 1, 0.4], [388, 42, 0.9, 0.35], [418, 25, 0.8, 0.4]], k.spark)
  } else if (state === 'cold') {
    css +=
      `.f{transform-box:fill-box;transform-origin:center;animation:spin linear infinite;animation-delay:var(--o,0s)}` +
      `.fp{fill:none;stroke:${k.rim};stroke-width:.85;stroke-linecap:round;stroke-linejoin:round;opacity:.9}` +
      `.rv{animation-direction:reverse}` +
      `.d{animation:drift ease-in-out infinite alternate;animation-delay:var(--o,0s)}` +
      `.gl{fill:${k.spark};opacity:0;animation:tw 4.5s ease-in-out infinite;animation-delay:var(--o,0s)}` +
      `.fr{stroke:${k.rim};stroke-width:.6;fill:none;stroke-linecap:round;opacity:.42}` +
      '.br{animation:br 7s ease-in-out infinite;animation-delay:var(--o,0s)}@keyframes br{0%,100%{opacity:.85}50%{opacity:1}}' +
      '@keyframes spin{to{transform:rotate(360deg)}}@keyframes drift{from{transform:translate(0,0)}to{transform:translate(var(--x,4px),var(--y,3px))}}' +
      '@keyframes tw{0%,66%,100%{opacity:0}78%{opacity:.9}}'
    defs = `<linearGradient id="rime" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c3}" stop-opacity=".2"/><stop offset=".26" stop-color="${c3}" stop-opacity="0"/><stop offset=".74" stop-color="${c3}" stop-opacity="0"/><stop offset="1" stop-color="${c3}" stop-opacity=".2"/></linearGradient>`
    const frost = [
      branch(W, 15, 105, 20, 2), branch(W, 15, 140, 24, 2), branch(W, 15, 172, 16, 1),
      branch(W, 49, -105, 20, 2), branch(W, 49, -140, 24, 2), branch(W, 49, -172, 16, 1),
    ].join('')
    const glints = ([[133, 44, 0.9, 0], [141, 26, 0.8, -1.3], [159, 16, 0.8, -2.4], [185, 47, 0.8, -0.7], [204, 29, 0.9, -3.1], [166, 46, 0.8, -1.9]] as const)
      .map(([x, y, r, o]) => `<circle class="gl" cx="${x}" cy="${y}" r="${r}" style="--o:${o}s"/>`)
      .join('')
    // Each flake: an outer drift (sway a few px, 15-22 s, alternating) around an inner spin (11-17 s).
    const flakes = ([[149, 37, 6.5, 12, 18, -4, '3px', '-3px', false], [173, 25, 7.5, 15, 22, -9, '-3px', '3px', true], [196, 38, 6, 11, 16, -2, '3px', '3px', false]] as const)
      .map(([x, y, r, spin, drift, o, dx, dy, rev]) =>
        `<g class="d" style="animation-duration:${drift}s;--o:${o}s;--x:${dx};--y:${dy}"><g class="f${rev ? ' rv' : ''}" style="animation-duration:${spin}s;--o:${n1(o * 1.7)}s"><path class="fp" d="${flake(x, y, r)}"/></g></g>`)
      .join('')
    // Without a free strip (a narrow band) the flakes would sit under the text: leave them out, keep the frost.
    extra = `<rect width="${W}" height="${H}" fill="url(#rime)"/><path class="fr" d="${frost}"/>${strip ? glints + flakes : ''}`
  }
  // 'dim' has no extras and no motion.
  return (
    `<svg ${NS} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMid slice"><style>${css}</style>` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset=".15" stop-color="${c1}" stop-opacity="0"/><stop offset=".5" stop-color="${c1}" stop-opacity="${k.a[0]}"/><stop offset=".8" stop-color="${c2}" stop-opacity="${k.a[1]}"/><stop offset="1" stop-color="${c3}" stop-opacity="${k.a[2]}"/></linearGradient>` +
    `<radialGradient id="r" cx="420" cy="${MID}" r="130" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${state === 'off' ? OFF_EMBER[theme] : c3}" stop-opacity="${k.glow}"/><stop offset="1" stop-color="${state === 'off' ? OFF_EMBER[theme] : c3}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="${k.grain}" fill-opacity="${k.grainA}"/></pattern>${state === 'cold' ? fade('.1', '.28') : fade('.12', '.5')}${defs}${fadeDown ? VFADE : ''}</defs>` +
    `${fadeDown ? '<g mask="url(#m2)">' : ''}<g mask="url(#m)"><rect${br || ' class="br"'} width="${W}" height="${H}" fill="url(#g)"/><rect${br} width="${W}" height="${H}" fill="url(#r)"/><rect width="${W}" height="${H}" fill="url(#grain)"/>${extra}</g>${fadeDown ? '</g>' : ''}</svg>`
  )
}

// ---------- full-width overlays (760x37, stretched: "none", non-scaling strokes) ----------

const FW = ART_FULL.width
const FH = ART_FULL.height

/** The effortless rim: a blurred 4px halo under a crisp 1.5px line, 1px inside the border all round. */
const rimShapes = (k: Ink) =>
  `<rect x="0" y="0" width="${FW}" height="${FH}" rx="8" fill="none" stroke="${k.rim}" stroke-width="4" opacity="${k.haloA}" filter="url(#b)"/>` +
  `<rect x=".75" y="1.75" width="${FW - 1.5}" height="${FH - 3.5}" rx="8.25" fill="none" stroke="${k.rim}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`

const fullSvg = (css: string, defs: string, body: string) =>
  `<svg ${NS} width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}" preserveAspectRatio="none"><style>${css}</style><defs><filter id="b" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="1.5"/></filter>${defs}</defs>${body}</svg>`

/** A rim that breathes between `lo` and `hi` over `seconds`. */
function breathingRim(state: ArtState, theme: ArtTheme, seconds: number, lo: number, hi: number): string {
  const css = `.r{opacity:${lo};animation:r ${seconds}s ease-in-out infinite;animation-delay:var(--o,0s)}@keyframes r{0%,100%{opacity:${lo}}50%{opacity:${hi}}}`
  return fullSvg(css, '', `<g class="r">${rimShapes(INK[theme][state])}</g>`)
}

/** Refreshing: a soft slanted golden flare crossing the whole width every 1.6 s (moving 0-85% of the loop, then a rest),
 * over a still rim. */
function sweepSvg(theme: ArtTheme): string {
  const k = INK[theme].refreshing
  const light = theme === 'light'
  // Light mode: white on a pale band is invisible (1.1:1), so the highlight is the accent at low alpha instead.
  const core = light ? k.rim : '#ffe9b0'
  const css =
    '.s{animation:s 1.6s cubic-bezier(.35,.15,.65,.85) infinite;animation-delay:var(--o,0s)}' +
    '@keyframes s{0%{transform:translateX(-300px)}85%,100%{transform:translateX(820px)}}'
  const defs =
    `<linearGradient id="w" x1="0" x2="1"><stop offset="0" stop-color="${k.rim}" stop-opacity="0"/><stop offset=".5" stop-color="${core}" stop-opacity="${light ? 0.2 : 0.12}"/><stop offset="1" stop-color="${k.rim}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="v" x1="0" x2="1"><stop offset="0" stop-color="${core}" stop-opacity="0"/><stop offset=".5" stop-color="${core}" stop-opacity="${light ? 0.28 : 0.18}"/><stop offset="1" stop-color="${core}" stop-opacity="0"/></linearGradient>`
  const body =
    `<g opacity=".6">${rimShapes(k)}</g>` +
    `<g class="s"><rect x="0" y="-6" width="260" height="${FH + 12}" fill="url(#w)" transform="skewX(-22)"/><rect x="107" y="-6" width="46" height="${FH + 12}" fill="url(#v)" transform="skewX(-22)"/></g>`
  return fullSvg(css, defs, body)
}

// ---------- layers ----------

/** The full-width overlay of a state (a rim that breathes, or the refreshing flare), built once per state and theme. */
const overlays = new Map<string, { key: string; src: string } | null>()

function overlay(state: ArtState, theme: ArtTheme): { key: string; src: string } | null {
  const id = `${theme}:${state}`
  const hit = overlays.get(id)
  if (hit !== undefined) return hit
  const rim = (seconds: number, lo: number, hi: number) => ({ key: `ck-${state}-rim`, src: breathingRim(state, theme, seconds, lo, hi) })
  const out =
    state === 'warm' ? rim(8, 0.4, 0.58)
    : state === 'refreshing' ? { key: 'ck-refreshing-sweep', src: sweepSvg(theme) }
    : state === 'cold' ? rim(7, 0.3, 0.7)
    : state === 'cooling' ? rim(2, 0.3, 0.85)
    : state === 'error' ? rim(3, 0.25, 0.7)
    : null // off and dim keep no overlay: still
  overlays.set(id, out)
  return out
}

/**
 * The layers to draw behind the band for `state`, in paint order. Every looping one is already phase-locked to `nowMs`:
 * the ember art by its own per-element delays, the cold art and the overlays by `inPhase`.
 * `strip: false` leaves the cold flakes and glints out (default true): the band has no free strip beside its text.
 * `fadeDown: true` (the sheet) also fades the right art out toward its bottom edge.
 */
export function artLayers(state: ArtState, o: { light: boolean; nowMs: number; strip?: boolean; fadeDown?: boolean }): ArtLayer[] {
  const theme: ArtTheme = o.light ? 'light' : 'dark'
  const right = rightArt(state, theme, o.strip ?? true, o.nowMs, o.fadeDown ?? false)
  const layers: ArtLayer[] = [
    { key: `ck-${state}-art`, svg: state === 'cold' ? inPhase(right, o.nowMs) : right, ...ART_RIGHT, anchor: 'right' },
  ]
  const full = overlay(state, theme)
  if (full) layers.push({ key: full.key, svg: inPhase(full.src, o.nowMs), ...ART_FULL, anchor: 'full' })
  return layers
}

// ---------- icons ----------

/** The settings cog: 14 px, 8 teeth, outline, centred in a `boxW` px wide image (the width of its click target). Drawn (not
 * a font glyph, which differs per font). From effortless's `settingsSvg`. */
export function gearSvg(color: string, boxW = 14): string {
  const step = (2 * Math.PI) / 8
  const pts: string[] = []
  for (let i = 0; i < 8; i++) {
    const a = i * step
    const at = (f: number, r: number) => `${(7 + r * Math.cos(a + f * step)).toFixed(2)},${(7 + r * Math.sin(a + f * step)).toFixed(2)}`
    pts.push(at(-0.42, 4.6), at(-0.27, 4.6), at(-0.2, 6.1), at(0.2, 6.1), at(0.27, 4.6), at(0.42, 4.6))
  }
  return `<svg ${NS} width="${boxW}" height="14" viewBox="0 0 ${boxW} 14"><g transform="translate(${n1((boxW - 14) / 2)} 0)" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round" shape-rendering="geometricPrecision"><path d="M${pts.join('L')}Z"/><circle cx="7" cy="7" r="2"/></g></svg>`
}

/** The on/off switch: a 28x16 pill (scaled to `h` px tall, 16 by default) centred in a `boxW` px image (its click target). On = the accent, the knob
 * right; off = a neutral track, the knob left. No text. */
export function toggleSvg(on: boolean, c: ArtColors, boxW = 31, h = 16): string {
  const w = boxW / (h / 16) // the drawing's own width: the viewBox scales it to `h`
  const x = (w - 28) / 2
  const track = on
    ? `<rect x="${n1(x)}" y="1" width="28" height="14" rx="7" fill="${c.accent}"/>`
    : `<rect x="${n1(x + 0.5)}" y="1.5" width="27" height="13" rx="6.5" fill="${c.dim}" fill-opacity=".22" stroke="${c.dim}" stroke-width="1"/>`
  const knob = on
    ? `<circle cx="${n1(x + 21)}" cy="8" r="5.2" fill="${c.bg}"/>`
    : `<circle cx="${n1(x + 7)}" cy="8" r="4.6" fill="${c.dim}"/>`
  return `<svg ${NS} width="${boxW}" height="${h}" viewBox="0 0 ${n1(w)} 16">${track}${knob}</svg>`
}

/** The keep chip: the window as a small outlined pill (`8h`, `∞`) centred in a `boxW` px image (its click target). The text
 * takes the app's band font; the pill is the state's accent. */
export function chipSvg(label: string, c: ArtColors, boxW = 39): string {
  const w = Math.min(boxW - 2, Math.max(26, Math.ceil([...label].length * 8 + 14)))
  const x = n1((boxW - w) / 2)
  return (
    `<svg ${NS} width="${boxW}" height="18" viewBox="0 0 ${boxW} 18"><rect x="${x}" y="1" width="${w}" height="16" rx="8" fill="${c.accent}" fill-opacity=".14" stroke="${c.accent}" stroke-opacity=".7" stroke-width="1"/>` +
    `<text x="${n1(boxW / 2)}" y="13" text-anchor="middle" style="font-size:12px;font-weight:600;fill:${c.text}">${label}</text></svg>`
  )
}

/**
 * The elsewhere chip: a small flame and the number of the user's other sessions that are warming (`9+` from ten), as an outlined pill in
 * the ember colours (always, whatever this session's own tone: it is about other sessions), centred in a `boxW` px image (its click
 * target). The flame breathes gently (2.6 s, opacity and a slight lift), phase-locked to `nowMs` like the dot, so a redraw does not restart it.
 */
export function emberSvg(count: number, light: boolean, boxW: number, nowMs: number): string {
  const e = PALETTE[light ? 'light' : 'dark'].warm
  const label = count > 9 ? '9+' : String(count)
  const w = Math.min(boxW - 2, Math.ceil([...label].length * 7.5 + 28))
  const x = (boxW - w) / 2
  const flame = 'M5 .6C5.7 3 8.7 4.7 8.7 8.3A3.7 3.7 0 0 1 1.3 8.3C1.3 6.9 1.9 5.9 2.7 5C3 6 3.5 6.4 4 6.4 4 4 4.1 2 5 .6Z'
  const css = '.f{transform-box:fill-box;transform-origin:50% 100%;animation:f 2.6s ease-in-out infinite}@keyframes f{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:1;transform:scale(1.08,1.12)}}'
  const svg =
    `<svg ${NS} width="${boxW}" height="18" viewBox="0 0 ${boxW} 18"><style>${css}</style><rect x="${n1(x)}" y="1" width="${n1(w)}" height="16" rx="8" fill="${e.accent}" fill-opacity=".14" stroke="${e.accent}" stroke-opacity=".7" stroke-width="1"/>` +
    `<g transform="translate(${n1(x + 8)} 2.5)"><path class="f" d="${flame}" fill="${e.accent}"/></g>` +
    `<text x="${n1(x + w - 9)}" y="13" text-anchor="end" style="font-size:12px;font-weight:600;fill:${e.text}">${label}</text></svg>`
  return inPhase(svg, nowMs)
}

/** The close mark: an X in the gear's stroke (1.3 px, the text colour), 14 px high, centred in a `boxW` px image (its click target). Drawn, not
 * a glyph: a text X in a blank-padded Button came out as two dots. */
export function closeSvg(color: string, boxW = 24): string {
  return `<svg ${NS} width="${boxW}" height="14" viewBox="0 0 ${boxW} 14"><g transform="translate(${n1((boxW - 14) / 2)} 0)" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" shape-rendering="geometricPrecision"><path d="M3.6 3.6L10.4 10.4M10.4 3.6L3.6 10.4"/></g></svg>`
}

/** The info mark after a setting's label: a ring with an i, 13 px, in the close mark's stroke family. */
export function infoSvg(color: string): string {
  return `<svg ${NS} width="13" height="13" viewBox="0 0 11 11"><g fill="none" stroke="${color}" stroke-width="1.1" stroke-linecap="round" shape-rendering="geometricPrecision"><circle cx="5.5" cy="5.5" r="4.7"/><path d="M5.5 5.1v2.6"/></g><circle cx="5.5" cy="3.3" r=".75" fill="${color}"/></svg>`
}

/** The Save as default pill: the accent's outlined pill with its label in the text colour (accent on the tinted fill fell under 4.5:1 on the light theme), filling a `boxW` px image (its click target). */
export function saveSvg(label: string, c: ArtColors, boxW: number): string {
  return (
    `<svg ${NS} width="${boxW}" height="18" viewBox="0 0 ${boxW} 18"><rect x="1" y="1" width="${n1(boxW - 2)}" height="16" rx="8" fill="${c.accent}" fill-opacity=".14" stroke="${c.accent}" stroke-opacity=".7" stroke-width="1"/>` +
    `<text x="${n1(boxW / 2)}" y="13" text-anchor="middle" style="font-size:12px;font-weight:600;fill:${c.text}">${label}</text></svg>`
  )
}

const lum = (h: string): number => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
/** The label on an accent fill: the panel colour (it is what the pill is cut out of), or white where that is the clearer of the two (the light theme's deeper accents). */
export const onAccent = (c: ArtColors): string => (contrast(c.bg, c.accent) >= contrast('#ffffff', c.accent) ? c.bg : '#ffffff')

/**
 * The segmented control: one rounded track, `labels` in segments `cells` wide (any ratio; the image is `boxW` px and each segment is its
 * share of it), hairlines between them, the selected one an inset pill in the accent with its label in the panel colour, bold. `selected`
 * -1 selects none. `h` px high (20 by default; the drawing scales), one row. The label text takes the app's band font.
 */
export function segSvg(labels: readonly string[], cells: readonly number[], selected: number, c: ArtColors, boxW: number, h = 20): string {
  const w = boxW / (h / 20) // the drawing's own width: the viewBox scales it to `h` px tall (20 by default)
  const k = w / cells.reduce((a, b) => a + b, 0)
  const edges = cells.reduce<number[]>((xs, w) => [...xs, (xs[xs.length - 1] ?? 0) + w * k], [0])
  const parts = labels.map((label, i) => {
    const x0 = edges[i] as number
    const x1 = edges[i + 1] as number
    const on = i === selected
    return (
      (on ? `<rect x="${n1(x0 + 2.5)}" y="2.5" width="${n1(x1 - x0 - 5)}" height="15" rx="7.5" fill="${c.accent}"/>` : '') +
      (i > 0 && i !== selected && i - 1 !== selected ? `<line x1="${n1(x0)}" y1="5.5" x2="${n1(x0)}" y2="14.5" stroke="${c.edge}" stroke-width="1"/>` : '') +
      `<text x="${n1((x0 + x1) / 2)}" y="14.6" text-anchor="middle" style="font-size:13px;font-weight:${on ? 700 : 500};fill:${on ? onAccent(c) : c.dim}">${label}</text>`
    )
  })
  return `<svg ${NS} width="${boxW}" height="${h}" viewBox="0 0 ${n1(w)} 20"><rect x=".5" y=".5" width="${n1(w - 1)}" height="19" rx="9.5" fill="${c.accent}" fill-opacity=".06" stroke="${c.edge}" stroke-width="1"/>${parts.join('')}</svg>`
}

/**
 * The dot slider: `n` stops at equal steps (each the centre of an equal slice of the `boxW` px image) joined by a line; the line and the
 * dots up to the selected stop in the accent, the rest in the dim colour (at least 3:1 on the band's background; the edge colour is 1.3-2.0:1) as a thin track and ring dots, so the filled part differs by shape and width as well as colour; the selected stop a larger ring with a dot in it. `h` px high (20 by default; the drawing scales).
 */
export function sliderSvg(n: number, selected: number, c: ArtColors, boxW: number, h = 20): string {
  const w = boxW / (h / 20)
  const cx = (i: number) => n1(((i + 0.5) * w) / n)
  const line = (a: number, b: number, color: string, w: number) => `<line x1="${cx(a)}" y1="10" x2="${cx(b)}" y2="10" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`
  const dots = Array.from({ length: n }, (_, i) =>
    i === selected
      ? `<circle cx="${cx(i)}" cy="10" r="9.5" fill="${c.accent}" fill-opacity=".16"/><circle cx="${cx(i)}" cy="10" r="7" fill="${c.bg}" stroke="${c.accent}" stroke-width="2"/><circle cx="${cx(i)}" cy="10" r="2.8" fill="${c.accent}"/>`
      : i < selected
        ? `<circle cx="${cx(i)}" cy="10" r="3.5" fill="${c.accent}"/>`
        : `<circle cx="${cx(i)}" cy="10" r="3" fill="${c.bg}" stroke="${c.dim}" stroke-width="1.5"/>`, // a ring: told from a filled dot by shape, since dim equals accent in the off and dim states
  )
  return `<svg ${NS} width="${boxW}" height="${h}" viewBox="0 0 ${n1(w)} 20">${line(0, n - 1, c.dim, 1)}${selected > 0 ? line(0, selected, c.accent, 2) : ''}${dots.join('')}</svg>`
}

/** One `<text>` frame of a countdown: when it shows (ms after the draw) and for how long (Infinity: to the end). */
export type ClockFrame = { label: string; at: number; ms: number }

const CLOCK_MAX_FRAMES = 64

/**
 * The frames of a minute-by-minute countdown from `ms` left, each label what `fmtMinutes` says for the time left while
 * it shows: the first label to the nearest half-minute boundary, one per minute after, and `now` for the last 30 s.
 * At most 64 frames; the last one that fits then stays (a countdown from more than 63 minutes).
 */
export function clockFrames(ms: number, label: (ms: number) => string): ClockFrame[] {
  const m0 = Math.round(Math.max(0, ms) / 60_000)
  if (m0 < 1) return [{ label: label(ms), at: 0, ms: Infinity }]
  const frames: ClockFrame[] = [{ label: label(m0 * 60_000), at: 0, ms: ms - (m0 - 0.5) * 60_000 }]
  let m = m0 - 1
  for (; m >= 1 && frames.length < CLOCK_MAX_FRAMES - 1; m--)
    frames.push({ label: label(m * 60_000), at: ms - (m + 0.5) * 60_000, ms: 60_000 })
  const last = frames[frames.length - 1] as ClockFrame
  // Cut short (over an hour left): the last label stays rather than claim `now`.
  if (m >= 1) last.ms = Infinity
  else frames.push({ label: label(0), at: last.at + last.ms, ms: Infinity })
  return frames
}

/** px of a digit and of a letter in the app's band font at 13 px (a letter, `m` and `h` above all, is wider than the 7.9 px cell). */
const DIGIT_PX = 7.8
const LETTER_PX = 10.5
export const clockWidth = (frames: readonly ClockFrame[]): number =>
  Math.ceil(Math.max(...frames.map(f => [...f.label].reduce((w, ch) => w + (/\d/.test(ch) ? DIGIT_PX : LETTER_PX), 0)))) + 2

/**
 * A countdown that ticks with no redraw (effortless's `cacheClockSvg`, MIT, (c) 2026 HeyCubit): one `<text>` frame per
 * minute, each shown for its minute by a `step-end` animation delayed to when it starts. The app sets the image's font
 * to the band's; the colour is given.
 */
export function clockSvg(frames: readonly ClockFrame[], color: string): string {
  const w = clockWidth(frames)
  const sec = (v: number) => (Number.isFinite(v) ? n1(Math.round(v) / 1000) : '100000')
  const texts = frames
    .map(f => `<text x="0" y="12.5" style="animation-delay:${sec(f.at)}s;animation-duration:${sec(f.ms)}s">${f.label}</text>`)
    .join('')
  return `<svg ${NS} width="${w}" height="17" viewBox="0 0 ${w} 17"><style>text{font-size:13px;fill:${color};opacity:0;animation:f 1s step-end 1}@keyframes f{0%{opacity:1}100%{opacity:0}}</style>${texts}</svg>`
}

/** A 10 px status dot in the state's accent: filled, hollow for `dim` and `off`; pulses for `refreshing` (1.6 s), `cooling`
 * (2 s) and `error` (3 s), phase-locked to `nowMs` like the art (a redraw restarts the image). */
export function dotSvg(state: ArtState, light: boolean, nowMs: number): string {
  const c = PALETTE[light ? 'light' : 'dark'][state].accent
  const period = state === 'refreshing' ? 1.6 : state === 'cooling' ? 2 : state === 'error' ? 3 : 0
  const css = period ? `.p{animation:p ${period}s ease-in-out infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}` : ''
  const shape =
    state === 'dim' || state === 'off'
      ? `<circle cx="5" cy="5" r="3" fill="none" stroke="${c}" stroke-width="1.3"/>`
      : `<circle cx="5" cy="5" r="4.2" fill="${c}" opacity=".22"/><circle cx="5" cy="5" r="2.8" fill="${c}"/>`
  const svg = `<svg ${NS} width="10" height="10" viewBox="0 0 10 10"><style>${css}</style><g class="${period ? 'p' : ''}">${shape}</g></svg>`
  return period ? inPhase(svg, nowMs) : svg
}
