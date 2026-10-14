// Films docs/capture.html into docs/states.gif and docs/settings.gif (the README's animations).
// Run, from the mod folder: node tools/record-gifs.mjs     (needs node, npm, ffmpeg and Chromium; Playwright is installed on the fly)
// It writes the page with `npx tsx tools/preview.ts --capture`, opens it in headless Chromium at 2x, steps through the timelines
// below in real time (so the SVG/CSS animations move) while a loop screenshots the stage, then turns the timed frames into a
// looping GIF with ffmpeg's palettegen/paletteuse.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const FPS = 15
const WIDTH = 1200 // GIF px wide; the page is shot at 2x (about 1560) and scaled down
const HOLD = 3000

// slide: show window.show(name, i); hover: a settings id whose label the pointer moves onto (null: move it away); ms: how long to hold.
const GIFS = {
  states: [0, 1, 2, 3, 4].map(i => ({ slide: ['states', i], ms: HOLD })),
  settings: [
    { slide: ['settings', 0], ms: 1500 },
    ...['keepFor', 'lead', 'minTokens', 'weeklyGuard'].map(hover => ({ hover, ms: 2600 })),
    { hover: null, ms: 1200 },
    { slide: ['settings', 1], ms: 1500 },
    ...['keepFor', 'weeklyGuard'].map(hover => ({ hover, ms: 2400 })),
    { hover: null, ms: 1000 },
  ],
}

execFileSync('npx', ['-y', 'tsx', 'tools/preview.ts', '--capture'], { cwd: root, stdio: 'inherit' })
// Playwright 1.64 matches Chromium revision 1248; pin it so the browser cache (~/Library/Caches/ms-playwright) is reused.
const pw = join(tmpdir(), 'cache-keeper-playwright')
if (!existsSync(join(pw, 'node_modules', 'playwright-core'))) {
  mkdirSync(pw, { recursive: true })
  execFileSync('npm', ['i', '--prefix', pw, '--no-audit', '--no-fund', 'playwright-core@1.64.0'], { stdio: 'inherit' })
}
const { chromium } = createRequire(join(pw, 'x.js'))('playwright-core')

const browser = await chromium.launch()
const page = await (await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 900, height: 700 } })).newPage()
await page.goto(new URL('docs/capture.html', `file://${root}/`).href)

for (const [name, steps] of Object.entries(GIFS)) {
  const frames = []
  let done = false
  await page.evaluate(([n, i]) => window.show(n, i), steps[0].slide)
  await page.mouse.move(890, 690)
  const clip = await page.locator('.stage').boundingBox()
  const shoot = (async () => {
    while (!done) frames.push({ t: Date.now(), png: await page.screenshot({ clip, type: 'png' }) })
  })()
  for (const s of steps) {
    if (s.slide) await page.evaluate(([n, i]) => window.show(n, i), s.slide)
    if (s.hover !== undefined) {
      const box = s.hover ? await page.locator(`.lab[data-id="${s.hover}"] .t`).first().boundingBox() : null
      await (box ? page.mouse.move(box.x + 4, box.y + box.height / 2) : page.mouse.move(890, 690))
    }
    await page.waitForTimeout(s.ms)
  }
  done = true
  await shoot

  // ffmpeg's concat demuxer takes each frame's real duration, so uneven screenshot timing does not speed up or slow down the GIF.
  const dir = mkdtempSync(join(tmpdir(), `cache-keeper-${name}-`))
  const list = frames.map((f, i) => {
    writeFileSync(join(dir, `${i}.png`), f.png)
    return `file '${i}.png'\nduration ${(((frames[i + 1]?.t ?? f.t + 1000 / FPS) - f.t) / 1000).toFixed(3)}`
  })
  writeFileSync(join(dir, 'list.txt'), list.join('\n'))
  const out = join(root, 'docs', `${name}.gif`)
  const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-i', join(dir, 'list.txt'), '-vf', vf, '-loop', '0', out], { stdio: 'inherit' })
  rmSync(dir, { recursive: true })
  console.log(`${out}: ${frames.length} frames shot (${(frames.length / (steps.reduce((a, s) => a + s.ms, 0) / 1000)).toFixed(1)}/s)`)
}
await browser.close()
