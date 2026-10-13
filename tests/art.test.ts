import { expect, test } from 'claude-code/testing'

import { ART_FULL, ART_RIGHT, ART_STATES, COLD_MAX_X, COLD_MIN_X, PALETTE, artLayers, clockFrames, clockSvg, clockWidth, dotSvg, gearSvg, chipSvg, closeSvg, infoSvg, inPhase, onAccent, saveSvg, segSvg, sliderSvg, toggleSvg } from '../hooks/art'
import { fmtMinutes } from '../hooks/policy'
import type { ArtState } from '../hooks/art'

const THEMES = ['dark', 'light'] as const
const PHASE = /<style>svg \*\{animation-delay:[^}]*\}<\/style><\/svg>$/

// Tiny well-formedness check: tags balance, one root, attributes are name="value", no stray & or <.
function wellFormed(xml: string): string | null {
  const stack: string[] = []
  let roots = 0
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<!--[\s\S]*?-->|([^<]+)/g
  let pos = 0
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m.index !== pos) return `unparsed text at ${pos}: ${xml.slice(pos, pos + 40)}`
    pos = re.lastIndex
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[5])) return 'stray &'
      if (stack.length === 0 && m[5].trim()) return 'text outside root'
      continue
    }
    if (m[2] === undefined) continue // a comment
    if (m[1]) {
      if (stack.pop() !== m[2]) return `unbalanced </${m[2]}>`
    } else {
      if (stack.length === 0 && ++roots > 1) return 'two roots'
      if (!m[4]) stack.push(m[2])
    }
  }
  if (pos !== xml.length) return `unparsed tail: ${xml.slice(pos, pos + 40)}`
  return stack.length ? `unclosed <${stack.at(-1)}>` : roots === 1 ? null : 'no root'
}

const all = THEMES.flatMap(th =>
  ART_STATES.flatMap(state => artLayers(state, { light: th === 'light', nowMs: 1_234_567 }).map(l => ({ name: `${th}/${state}/${l.key}`, ...l }))),
)
const icons = [
  { name: 'gear', svg: gearSvg('#abcdef') },
  { name: 'gear in a 24 px box', svg: gearSvg('#abcdef', 24) },
  ...THEMES.flatMap(th => [true, false].map(on => ({ name: `toggle/${th}/${on}`, svg: toggleSvg(on, PALETTE[th].warm, 31) }))),
  ...[50 * 60_000, 3 * 60_000, 20_000, 59 * 60_000 + 40_000, 63 * 60_000 + 30_000].map(ms => ({ name: `clock/${ms}`, svg: clockSvg(clockFrames(ms, fmtMinutes), '#fff') })),
  ...['2h', '12h', '∞'].map(l => ({ name: `chip/${l}`, svg: chipSvg(l, PALETTE.dark.warm, 39) })),
  { name: 'chip light', svg: chipSvg('8h', PALETTE.light.cooling, 39) },
  { name: 'close', svg: closeSvg('#abcdef', 23) },
  { name: 'info', svg: infoSvg('#abcdef') },
  { name: 'save', svg: saveSvg('Save as default', PALETTE.dark.warm, 134) },
  ...THEMES.flatMap(th => [-1, 0, 2, 4].map(i => ({ name: `seg/${th}/${i}`, svg: segSvg(['2h', '4h', '8h', '12h', '∞'], [5, 5, 5, 5, 5], i, PALETTE[th].warm, 197) }))),
  ...THEMES.flatMap(th => [0, 2, 4].map(i => ({ name: `slider/${th}/${i}`, svg: sliderSvg(5, i, PALETTE[th].warm, 197) }))),
  ...THEMES.flatMap(th => ART_STATES.map(s => ({ name: `dot/${th}/${s}`, svg: dotSvg(s, th === 'light', 1_234_567) }))),
]

test('every exported SVG is well-formed XML with width/height, under 20k chars, with no forbidden constructs', () => {
  expect(all.length).toBe(24)
  for (const { name, svg } of [...all, ...icons]) {
    expect(wellFormed(svg), name).toBeNull()
    expect(svg.length, name).toBeLessThan(20_000)
    expect(svg, name).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" /)
    expect(svg, name).not.toMatch(/clipPath|<script|\son\w+\s*=|isInteractive|<foreignObject|<image|href=/i)
  }
})

test('the well-formedness check itself catches broken markup', () => {
  for (const bad of ['<svg><g></svg>', '<svg></svg><svg></svg>', '<svg a=1></svg>', '<svg>a & b</svg>', '<svg><g>']) expect(wellFormed(bad), bad).not.toBeNull()
  expect(wellFormed('<svg a="1"><g/><!-- c --></svg>')).toBeNull()
})

test('layer sizes, anchors and aspect handling match what the app expects', () => {
  for (const l of all) {
    const size = l.anchor === 'right' ? ART_RIGHT : ART_FULL
    expect([l.width, l.height], l.name).toEqual([size.width, size.height])
    expect(l.svg, l.name).toContain(`width="${size.width}" height="${size.height}"`)
    if (l.anchor === 'right') {
      expect(l.svg, l.name).toContain('preserveAspectRatio="xMaxYMid slice"')
      // fades to transparent on the left so the text stays readable
      expect(l.svg, l.name).toMatch(/<mask id="m"><rect[^>]*fill="url\(#fade\)"/)
      expect(l.svg, l.name).toMatch(/<linearGradient id="fade"[^>]*><stop offset="\.\d+" stop-color="#fff" stop-opacity="0"\/>/)
    } else {
      expect(l.svg, l.name).toContain('preserveAspectRatio="none"')
      expect(l.svg, l.name).toContain('vector-effect="non-scaling-stroke"')
    }
  }
  expect(new Set(all.map(l => l.name)).size).toBe(all.length)
})

test('inPhase injects exactly one delay style at the end, keeps per-element staggers and clamps negatives', () => {
  const out = inPhase('<svg><g/></svg>', 1500)
  expect(out).toBe('<svg><g/><style>svg *{animation-delay:calc(var(--o,0s) - 1.500s) !important}</style></svg>')
  expect(inPhase('<svg></svg>', -50)).toContain('- 0.000s')
  for (const l of all) {
    const loops = l.svg.includes('@keyframes')
    // the ember art locks each loop by its own delay (one image holds many staggered loops): no image-wide `!important` there
    const own = /ck-(warm|refreshing|cooling|error)-art$/.test(l.name)
    expect(l.svg.split('!important').length - 1, l.name).toBe(loops && !own ? 1 : 0)
    if (loops && !own) expect(l.svg, l.name).toMatch(PHASE)
    if (own) expect(l.svg, l.name).not.toMatch(/var\(--o/)
  }
})

test('the source is constant per state and theme except the phase (the style at the end, and each ember loop\'s own delay)', () => {
  const strip = (svg: string) => svg.replace(PHASE, '</svg>').replace(/ -?\d+\.\d{3}s infinite/g, ' D infinite')
  for (const th of THEMES)
    for (const s of ART_STATES) {
      const a = artLayers(s, { light: th === 'light', nowMs: 0 })
      const b = artLayers(s, { light: th === 'light', nowMs: 987_654 })
      expect(a.map(l => strip(l.svg)), `${th}/${s}`).toEqual(b.map(l => strip(l.svg)))
      expect(a.map(l => l.key)).toEqual(b.map(l => l.key))
    }
  // the phase moves with the clock
  for (const [state, i] of [['cooling', 1], ['cooling', 0], ['warm', 0], ['error', 0], ['refreshing', 0]] as const) {
    const [x, y] = [artLayers(state, { light: false, nowMs: 1000 })[i]!.svg, artLayers(state, { light: false, nowMs: 2000 })[i]!.svg]
    expect(x, `${state}/${i}`).not.toBe(y)
  }
  // the same time, the same picture
  expect(artLayers('warm', { light: true, nowMs: 777 })[0]!.svg).toBe(artLayers('warm', { light: true, nowMs: 777 })[0]!.svg)
})

// Loop lengths in seconds found in a state's layers (`animation:name 3s ...`).
const periods = (state: ArtState) =>
  artLayers(state, { light: false, nowMs: 0 }).flatMap(l => [...l.svg.matchAll(/animation:\w+ ([\d.]+)s/g)].map(m => Number(m[1])))

test('motion budget per state: warm >= 6 s loops, refreshing 1.6 s, cooling 2 s, error 3 s, off and dim none, cold slow', () => {
  expect(periods('warm').length).toBeGreaterThan(0)
  for (const p of periods('warm')) expect(p).toBeGreaterThanOrEqual(6)
  expect(periods('refreshing')).toContain(1.6)
  expect(periods('cooling')).toContain(2)
  expect(periods('cooling').filter(p => p === 2).length).toBeGreaterThanOrEqual(2) // the glow and the rim pulse
  for (const p of periods('error')) expect(p).toBe(3)
  expect(periods('error').length).toBeGreaterThan(0)
  for (const st of ['dim', 'off'] as const)
    for (const l of artLayers(st, { light: false, nowMs: 5 })) expect(l.svg, st).not.toMatch(/@keyframes|animation/)
  for (const p of periods('cold')) expect(p).toBeGreaterThanOrEqual(4)
  // cold: a few snowflakes and twinkling glints, each flake spinning
  const cold = artLayers('cold', { light: false, nowMs: 0 })[0]!.svg
  expect((cold.match(/class="f( rv)?"/g) ?? []).length).toBeGreaterThanOrEqual(3)
  expect((cold.match(/class="gl"/g) ?? []).length).toBeGreaterThanOrEqual(3)
  expect(artLayers('refreshing', { light: false, nowMs: 0 }).map(l => l.key)).toContain('ck-refreshing-sweep')
})

const embersOf = (state: ArtState, nowMs: number, light = false) =>
  [...artLayers(state, { light, nowMs })[0]!.svg.matchAll(/<circle class="e" cx="([\d.]+)" cy="[\d.]+" r="[\d.]+" fill="(#\w+)" style="animation:(\w+) ([\d.]+)s linear (-?[\d.]+)s infinite/g)].map(m => ({
    x: Number(m[1]), color: m[2]!, name: m[3]!, period: Number(m[4]), delay: Number(m[5]),
  }))

test('warm: a heat glow and 6-8 embers rise on 6.5-10 s loops, staggered, every one locked to the clock, the left 45% clear', () => {
  for (const light of [false, true]) {
    const e = embersOf('warm', 12_345, light)
    expect(e.length, 'embers').toBeGreaterThanOrEqual(6)
    expect(e.length).toBeLessThanOrEqual(8)
    for (const m of e) {
      expect(m.name).toBe('up')
      expect(m.period).toBeGreaterThanOrEqual(6)
      expect(m.x).toBeGreaterThanOrEqual(ART_RIGHT.width * 0.45)
      // the delay is the loop's phase at this time: negative, shorter than the loop
      expect(m.delay).toBeLessThanOrEqual(0)
      expect(-m.delay).toBeLessThan(m.period)
    }
    expect(new Set(e.map(m => m.delay)).size, 'staggered').toBeGreaterThanOrEqual(6)
    expect(new Set(e.map(m => m.period)).size, 'different loop lengths').toBeGreaterThanOrEqual(4)
    // two draws a minute apart find every ember at the phase a minute on (period-wise): delay_b = delay_a - 60 (mod period)
    const b = embersOf('warm', 12_345 + 60_000, light)
    e.forEach((m, i) => {
      const want = -((((-m.delay + 60) % m.period) + m.period) % m.period)
      expect(Math.abs(b[i]!.delay - want) < 0.01 || Math.abs(b[i]!.delay - want - m.period) < 0.01 || Math.abs(b[i]!.delay - want + m.period) < 0.01, `ember ${i}`).toBe(true)
    })
    // the glow breathes on 8 s
    expect(artLayers('warm', { light, nowMs: 0 })[0]!.svg).toMatch(/animation:br 8s ease-in-out -?[\d.]+s infinite/)
  }
  // refreshing: the same embers brighter and quicker; cooling: embers sink; error and off: none
  expect(Math.max(...embersOf('refreshing', 0).map(m => m.period))).toBeLessThan(Math.min(...embersOf('warm', 0).map(m => m.period)) + 0.01)
  expect(embersOf('cooling', 0).every(m => m.name === 'sink')).toBe(true)
  for (const st of ['error', 'off', 'dim', 'cold'] as const) expect(embersOf(st, 0)).toEqual([])
})

test('off keeps a faint static ember glow; cooling shifts toward amber-red and blue; error is rose', () => {
  const stops = (state: ArtState) => [...artLayers(state, { light: false, nowMs: 0 })[0]!.svg.matchAll(/<linearGradient id="g"[^>]*>(.*?)<\/linearGradient>/g)][0]![1]!
  const glow = (state: ArtState) => /<radialGradient id="r"[^>]*><stop offset="0" stop-color="(#\w+)" stop-opacity="([\d.]+)"/.exec(artLayers(state, { light: false, nowMs: 0 })[0]!.svg)!
  expect(glow('off')[1]).toBe('#f39a52')
  expect(Number(glow('off')[2])).toBeLessThanOrEqual(0.08)
  expect(stops('cooling')).toMatch(/#b45309/) // amber
  expect(stops('cooling')).toMatch(/#5b8bd6/) // the cool end
  expect(PALETTE.dark.cooling.edge).not.toBe(PALETTE.dark.warm.edge)
  expect(PALETTE.dark.error.edge).toMatch(/^#8[0-9a-f]2[0-9a-f]4[0-9a-f]$/) // rose-red
  expect(PALETTE.dark.warm.accent).toBe('#f39a52')
  expect(PALETTE.dark.warm.bg).toBe('#1c120c')
})

const hex = /^#[0-9a-f]{6}$/
const lum = (h: string) => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

test('PALETTE has every state and key in both themes, as hex, with readable text', () => {
  expect(Object.keys(PALETTE).sort()).toEqual(['dark', 'light'])
  for (const th of THEMES) {
    expect(Object.keys(PALETTE[th]).sort()).toEqual([...ART_STATES].sort())
    for (const s of ART_STATES) {
      const c = PALETTE[th][s]
      expect(Object.keys(c).sort()).toEqual(['accent', 'bg', 'dim', 'edge', 'text'])
      for (const v of Object.values(c)) expect(v, `${th}/${s}`).toMatch(hex)
      expect(ratio(c.text, c.bg), `${th}/${s} text`).toBeGreaterThanOrEqual(7)
      expect(ratio(c.dim, c.bg), `${th}/${s} dim`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.accent, c.bg), `${th}/${s} accent`).toBeGreaterThanOrEqual(3)
    }
  }
})

test('dot pulses only for refreshing, cooling and error, phase-locked to the clock; gear is a 14 px outline', () => {
  for (const th of [false, true])
    for (const s of ART_STATES) {
      const dot = dotSvg(s, th, 5000)
      expect(dot).toContain('width="10" height="10"')
      const pulses = s === 'refreshing' || s === 'cooling' || s === 'error'
      expect(dot.includes('@keyframes'), s).toBe(pulses)
      expect(PHASE.test(dot), s).toBe(pulses)
      expect(dot).toContain(PALETTE[th ? 'light' : 'dark'][s].accent)
      // a redraw at another time moves the delay, not the picture
      expect(dotSvg(s, th, 6000) === dot, s).toBe(!pulses)
    }
  expect(dotSvg('cooling', false, 1500)).toContain('calc(var(--o,0s) - 1.500s)')
  expect(dotSvg('cooling', false, 0)).toContain('animation:p 2s')
  expect(gearSvg('#123456')).toMatch(/width="14" height="14".*stroke="#123456"/)
})

test('cold flakes and glints sit in the strip between the text and the button cluster (art x COLD_MIN_X..COLD_MAX_X); frost stays clear of it', () => {
  for (const light of [false, true]) {
    const svg = artLayers('cold', { light, nowMs: 0 })[0]!.svg
    const xs = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) -?[\d.]+/g)].map(m => Number(m[1]))
    const glints = [...svg.matchAll(/class="gl" cx="([\d.]+)"/g)].map(m => Number(m[1]))
    expect(glints.length).toBeGreaterThanOrEqual(3)
    for (const x of glints) {
      expect(x).toBeGreaterThanOrEqual(COLD_MIN_X)
      expect(x).toBeLessThanOrEqual(COLD_MAX_X)
    }
    const flakes = [...svg.matchAll(/--x:(-?[\d.]+)px[^"]*"><g class="f[^>]*><path class="fp" d="([^"]+)"/g)]
    expect(flakes.length).toBeGreaterThanOrEqual(3)
    for (const [, dx, d] of flakes) {
      expect(Math.min(...xs(d!)) + Math.min(0, Number(dx))).toBeGreaterThanOrEqual(COLD_MIN_X)
      expect(Math.max(...xs(d!)) + Math.max(0, Number(dx))).toBeLessThanOrEqual(COLD_MAX_X + 2)
    }
    // frost is the corner crystals under the cluster, not the strip
    expect(Math.min(...xs(/class="fr" d="([^"]+)"/.exec(svg)![1]!))).toBeGreaterThanOrEqual(COLD_MAX_X)
    // the cold fade is fully opaque before the strip starts (the other states fade in over the left 50%)
    const stop = Number(/<stop offset="(\.\d+)" stop-color="#fff" stop-opacity="1"/.exec(svg)![1])
    expect(stop * ART_RIGHT.width).toBeLessThanOrEqual(COLD_MIN_X)
  }
})

// Source-over of `fg` at alpha `a` on `bg`, hex in, hex out.
const over = (fg: string, a: number, bg: string) =>
  '#' + [1, 3, 5].map(i => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, '0')).join('')

test('the refreshing sweep at its brightest (both bands overlapped) keeps the text >= 4.5:1', () => {
  for (const th of THEMES) {
    const svg = artLayers('refreshing', { light: th === 'light', nowMs: 0 })[1]!.svg
    const c = PALETTE[th].refreshing
    let bg = c.bg
    for (const id of ['w', 'v']) {
      const m = new RegExp(`<linearGradient id="${id}"[^>]*><stop[^>]*/><stop offset="\\.5" stop-color="(#\\w+)" stop-opacity="([\\d.]+)"`).exec(svg)
      expect(m, `${th}/${id}`).not.toBeNull()
      bg = over(m![1]!, Number(m![2]), bg)
    }
    expect(ratio(c.text, bg), `${th} peak ${bg}`).toBeGreaterThanOrEqual(4.5)
  }
})

test('cold art without the strip keeps the frost and drops flakes and glints', () => {
  const svg = artLayers('cold', { light: false, nowMs: 0, strip: false })[0]!.svg
  expect(svg).toContain('class="fr"')
  expect(svg).not.toMatch(/class="(gl|f)[ "]/)
  expect(artLayers('cold', { light: false, nowMs: 0 })[0]!.svg).toContain('class="gl"')
})

test('the refreshing sweep is visible in both themes (peak at least 1.3:1 against the band) and stays readable', () => {
  for (const th of THEMES) {
    const svg = artLayers('refreshing', { light: th === 'light', nowMs: 0 })[1]!.svg
    const c = PALETTE[th].refreshing
    const peak = (id: string) => {
      const m = new RegExp(`<linearGradient id="${id}"[^>]*><stop[^>]*/><stop offset="\\.5" stop-color="(#\\w+)" stop-opacity="([\\d.]+)"`).exec(svg)!
      return [m[1]!, Number(m[2])] as const
    }
    const w = over(...peak('w'), c.bg)
    const both = over(...peak('v'), w)
    expect(ratio(w, c.bg), `${th} wide band`).toBeGreaterThanOrEqual(1.2)
    expect(ratio(both, c.bg), `${th} both bands`).toBeGreaterThanOrEqual(1.3)
    // light mode no longer lightens a pale band with white
    if (th === 'light') expect(peak('w')[0]).not.toBe('#ffffff')
  }
})

test('every text a pointer reveals reads on its own background in every state and both palettes (4.5:1): the band card (text, dim), the sheet\'s help (text) and the label turned accent', () => {
  for (const th of THEMES)
    for (const st of ART_STATES) {
      const c = PALETTE[th][st]
      for (const [name, fg] of [['card text', c.text], ['card dim', c.dim], ['help', c.text], ['label on hover', c.accent]] as const)
        expect(ratio(fg, c.bg), `${th}/${st} ${name}`).toBeGreaterThanOrEqual(4.5)
    }
})

test('the sheet\'s switch is scaled to 20 px: the same pill in a wider box, nothing else changes', () => {
  const c = PALETTE.dark.warm
  const on = toggleSvg(true, c, 39, 20)
  expect(on).toMatch(/^<svg [^>]*width="39" height="20" viewBox="0 0 31.2 16"/)
  expect(on).toMatch(/<rect x="1.6" y="1" width="28" height="14" rx="7"/)
  expect(toggleSvg(true, c, 31)).toContain('height="16" viewBox="0 0 31 16"') // the header's is unchanged
})

test('the toggle is a 28x16 pill centred in its box: accent track and knob right when on, a neutral track and knob left when off', () => {
  const c = PALETTE.dark.warm
  const on = toggleSvg(true, c, 31)
  const off = toggleSvg(false, c, 31)
  for (const svg of [on, off]) expect(svg).toMatch(/^<svg [^>]*width="31" height="16" viewBox="0 0 31 16"/)
  expect(on).toContain(`fill="${c.accent}"`)
  expect(off).not.toContain(`fill="${c.accent}"`)
  const knob = (svg: string) => Number(/<circle cx="([\d.]+)"/.exec(svg)![1])
  expect(knob(on)).toBeGreaterThan(31 / 2)
  expect(knob(off)).toBeLessThan(31 / 2)
  expect(on).toMatch(/<rect x="1.5" y="1" width="28" height="14" rx="7"/)
  // no text on it
  expect(on + off).not.toMatch(/<text/)
})

test('clockFrames tick a countdown by the minute with no redraw: one label per minute, each shown for its minute', () => {
  const f = clockFrames(50 * 60_000, fmtMinutes)
  expect(f.slice(0, 3)).toEqual([
    { label: '50m', at: 0, ms: 30_000 * 2 - 30_000 + 0 + 0 },
    { label: '49m', at: 30_000, ms: 60_000 },
    { label: '48m', at: 90_000, ms: 60_000 },
  ])
  expect(f.length).toBe(51) // 50m .. 1m, then now
  expect(f.at(-2)).toEqual({ label: '1m', at: 50 * 60_000 - 90_000, ms: 60_000 })
  expect(f.at(-1)).toEqual({ label: 'now', at: 50 * 60_000 - 30_000, ms: Infinity })
  // a frame shows from `at` for `ms`, and the next begins when it ends
  for (let i = 1; i < f.length; i++) expect(f[i]!.at).toBe(f[i - 1]!.at + f[i - 1]!.ms)
  // starts mid-minute: the first label holds only until the next half-minute boundary
  expect(clockFrames(50 * 60_000 + 20_000, fmtMinutes)[0]).toEqual({ label: '50m', at: 0, ms: 50_000 })
  expect(clockFrames(10_000, fmtMinutes)).toEqual([{ label: 'now', at: 0, ms: Infinity }])
  // an hour and more: hours and minutes, never more than 64 frames, the last label stays when it is cut
  const long = clockFrames(125 * 60_000, fmtMinutes)
  expect(long[0]!.label).toBe('2h05m')
  expect(long.length).toBeLessThanOrEqual(64)
  expect(long.at(-1)!.ms).toBe(Infinity)
  expect(long.at(-1)!.label).not.toBe('now')
  // the image: width fits the longest label, each frame is a <text> with its own delay and duration, step-end, ends invisible
  const svg = clockSvg(f, '#abc')
  expect(svg).toContain('animation:f 1s step-end 1')
  expect(svg).toContain('style="animation-delay:0s;animation-duration:30s">50m</text>')
  expect(svg).toContain('style="animation-delay:30s;animation-duration:60s">49m</text>')
  expect(svg).toContain('animation-duration:100000s">now</text>')
  expect(svg).toContain(`width="${clockWidth(f)}" height="17"`)
  expect(svg).toContain('fill:#abc')
  expect(svg.length).toBeLessThan(20_000)
  expect(clockSvg(long, '#abc').length).toBeLessThan(20_000)
})

test('the keep chip is a pill in the accent with the window centred in it, inside its box', () => {
  const c = PALETTE.dark.warm
  const svg = chipSvg('12h', c, 39)
  expect(svg).toContain('>12h</text>')
  expect(svg).toContain('width="39" height="18"')
  expect(svg).toContain(`stroke="${c.accent}"`)
  expect(svg).toContain('text-anchor="middle"')
  const w = Number(/<rect x="[\d.]+" y="1" width="(\d+)"/.exec(svg)?.[1])
  expect(w).toBeLessThanOrEqual(37)
})

// What the band's background is at its most coloured: the gradient's right end, the bloom and the grain over the bg.
test('every state keeps its text >= 4.5:1 on the art where text can reach (composited), 2.5:1 at the very edge, in both themes', () => {
  for (const th of THEMES)
    for (const state of ART_STATES) {
      const svg = artLayers(state, { light: th === 'light', nowMs: 0 })[0]!.svg
      const c = PALETTE[th][state]
      const end = /<stop offset="1" stop-color="(#\w+)" stop-opacity="([\d.]+)"\/><\/linearGradient>/.exec(svg)!
      const bloom = /<radialGradient id="r"[^>]*><stop offset="0" stop-color="(#\w+)" stop-opacity="([\d.]+)"/.exec(svg)!
      const grain = /<pattern id="grain"[^>]*><rect[^>]* fill="(#\w+)" fill-opacity="([\d.]+)"/.exec(svg)!
      let bg = over(end[1]!, Number(end[2]), c.bg)
      bg = over(bloom[1]!, Number(bloom[2]), bg)
      bg = over(grain[1] === '#fff' ? '#ffffff' : '#000000', Number(grain[2]), bg)
      // the very right edge sits under the controls only: their glyphs (and the ice art, which is unchanged) get 2.5:1
      expect(ratio(c.text, bg), `${th}/${state} text at the right edge ${bg}`).toBeGreaterThanOrEqual(2.5)
      // The text and dim parts (a reason, a suffix) can reach the control cluster at most: art x 352 of 440, the gradient's .8 stop and
      // about half the bloom (the controls sit beyond it).
      const mid = /<stop offset="\.8" stop-color="(#\w+)" stop-opacity="([\d.]+)"/.exec(svg)!
      let near = over(mid[1]!, Number(mid[2]), c.bg)
      near = over(bloom[1]!, Number(bloom[2]) * 0.5, near)
      expect(ratio(c.text, near), `${th}/${state} text on ${near}`).toBeGreaterThanOrEqual(4.5)
      // (the cold line has no dim part, and its ice art is as the person liked it)
      if (state !== 'cold') expect(ratio(c.dim, near), `${th}/${state} dim on ${near}`).toBeGreaterThanOrEqual(4.5)
    }
})

test('the sheet\'s art fades out toward its bottom edge; the band\'s does not', () => {
  for (const st of ART_STATES) {
    const sheet = artLayers(st, { light: false, nowMs: 0, fadeDown: true })[0]!.svg
    const band = artLayers(st, { light: false, nowMs: 0 })[0]!.svg
    expect(sheet, st).toMatch(/<g mask="url\(#m2\)"><g mask="url\(#m\)">/)
    expect(sheet, st).toMatch(/<mask id="m2">/)
    expect(band, st).not.toContain('m2')
    expect(wellFormed(sheet), st).toBeNull()
    expect(sheet.length, st).toBeLessThan(20_000)
  }
})

test('the close mark is an X in the gear\'s stroke, centred in its box; Save as default is an accent pill that fills its box', () => {
  const x = closeSvg('#abcdef', 23)
  expect(x).toContain('width="23" height="14"')
  expect(x).toContain('stroke="#abcdef" stroke-width="1.3"')
  expect(x).toContain('translate(4.5 0)')
  expect(gearSvg('#abcdef', 23)).toContain('stroke-width="1.3"') // the same stroke
  expect(x).not.toContain('<text') // drawn, not a glyph
  const c = PALETTE.dark.warm
  const save = saveSvg('Save as default', c, 134)
  expect(save).toContain('width="134" height="18"')
  expect(save).toContain('>Save as default</text>')
  expect(save).toContain(`fill:${c.text}`)
  expect(save).toContain('<rect x="1" y="1" width="132"')
})

test('the segmented control: a track in the edge colour, hairlines, the selected segment an accent pill with its label in the panel colour, bold', () => {
  const c = PALETTE.dark.warm
  const labels = ['2h', '4h', '8h', '12h', '∞']
  const svg = segSvg(labels, [5, 5, 5, 5, 5], 2, c, 100)
  expect(svg).toContain('width="100" height="20"')
  expect(svg).toContain(`stroke="${c.edge}" stroke-width="1"`)
  for (const l of labels) expect(svg).toContain(`>${l}</text>`)
  // the selected one (index 2: x 40..60) is the inset accent pill, its label in the panel colour at weight 700; the others dim
  expect(svg).toContain(`<rect x="42.5" y="2.5" width="15" height="15" rx="7.5" fill="${c.accent}"/>`)
  expect(svg).toContain(`font-weight:700;fill:${c.bg}">8h</text>`)
  expect(svg).toContain(`font-weight:500;fill:${c.dim}">4h</text>`)
  // hairlines between neighbours, none beside the selected pill: boundaries at x 20 and 80
  expect([...svg.matchAll(/<line x1="([\d.]+)"/g)].map(m => m[1])).toEqual(['20', '80'])
  // each label is centred in its own share
  expect(svg).toContain('<text x="10" y="14.6"')
  expect(svg).toContain('<text x="90" y="14.6"')
  // uneven widths split the image by their ratio: [5, 6] over 110 px is 50 / 60
  const uneven = segSvg(['a', 'b'], [5, 6], -1, c, 110)
  expect(uneven).toContain('<text x="25" ')
  expect(uneven).toContain('<text x="80" ')
  // nothing selected: no pill
  expect(uneven).not.toContain(`fill="${c.accent}"/>`)
})

test('the dot slider: stops at the centres of equal slices, the line and dots up to the selected one in the accent, the rest in the dim colour, a ring at the selected', () => {
  const c = PALETTE.dark.warm
  const svg = sliderSvg(5, 2, c, 100)
  expect(svg).toContain('width="100" height="20"')
  // slice centres at 10, 30, 50, 70, 90
  expect([...svg.matchAll(/<circle cx="([\d.]+)"/g)].map(m => m[1])).toEqual(['10', '30', '50', '50', '50', '70', '90'])
  expect(svg).toContain(`<line x1="10" y1="10" x2="90" y2="10" stroke="${c.dim}"`)
  expect(svg).toContain(`<line x1="10" y1="10" x2="50" y2="10" stroke="${c.accent}"`)
  expect(svg).toContain(`<circle cx="10" cy="10" r="3.5" fill="${c.accent}"/>`)
  expect(svg).toContain(`<circle cx="70" cy="10" r="3" fill="${c.bg}" stroke="${c.dim}" stroke-width="1.5"/>`)
  expect(svg).toContain(`r="7" fill="${c.bg}" stroke="${c.accent}"`)
  // the first stop selected: no accent line
  expect(sliderSvg(5, 0, c, 100)).not.toContain(`x2="10" y2`)
})

test('the slider\'s track and unselected dots are 3:1 against the panel in every state and theme (c.edge was 1.3-2.0:1)', () => {
  for (const th of THEMES)
    for (const st of ART_STATES) {
      const c = PALETTE[th][st]
      const svg = sliderSvg(5, 1, c, 100)
      const track = /<line x1="10" y1="10" x2="90" y2="10" stroke="(#[0-9a-f]{6})"/.exec(svg)?.[1]
      const dots = [...svg.matchAll(/r="3" fill="#[0-9a-f]{6}" stroke="(#[0-9a-f]{6})"/g)].map(m => m[1] as string)
      expect(track, `${th}/${st} track`).toBeDefined()
      expect(dots.length, `${th}/${st} unselected dots`).toBe(3)
      // told apart from the filled part by shape and width, even where dim equals accent (off, dim)
      expect(svg, `${th}/${st} filled dot`).toContain('r="3.5" fill="' + c.accent + '"/>')
      expect(svg, `${th}/${st} filled dot is not the unfilled markup`).not.toContain('r="3.5" fill="' + c.bg + '"')
      expect(svg, `${th}/${st} track width`).toContain(`stroke="${c.dim}" stroke-width="1"`)
      expect(svg, `${th}/${st} filled run width`).toContain(`stroke="${c.accent}" stroke-width="2"`)
      for (const colour of [track as string, ...dots]) expect(ratio(colour, c.bg), `${th}/${st} ${colour}`).toBeGreaterThanOrEqual(3)
    }
})

test('the sheet\'s drawn controls read in every state and theme: the selected label on the accent and the unselected label on the panel are both 4.5:1', () => {
  for (const th of THEMES)
    for (const st of ART_STATES) {
      const c = PALETTE[th][st]
      expect(ratio(onAccent(c), c.accent), `${th}/${st} selected label`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.dim, c.bg), `${th}/${st} unselected label`).toBeGreaterThanOrEqual(4.5)
    }
})

test('the info mark is a drawn ring and i, 13 px, in the close mark\'s stroke family; the labels and help (text) and the mark (dim) read on the panel in every state and theme', () => {
  const m = infoSvg('#abcdef')
  expect(m).toContain('width="13" height="13"')
  expect(m).toContain('<circle')
  expect(m).toContain('stroke="#abcdef"')
  expect(m).toContain('stroke-linecap="round"')
  expect(m).not.toContain('<text') // drawn, not a glyph
  for (const th of THEMES)
    for (const st of ART_STATES) {
      const c = PALETTE[th][st]
      expect(ratio(c.text, c.bg), `${th}/${st} label and help`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.dim, c.bg), `${th}/${st} info mark`).toBeGreaterThanOrEqual(3)
    }
})
