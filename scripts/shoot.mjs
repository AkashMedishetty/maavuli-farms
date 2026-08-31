// Capture the site so "is it broken" is answered with pixels, not opinion.
//
//   node scripts/shoot.mjs            hero at every size + buffalo + sections
//   node scripts/shoot.mjs hero       hero only (fast loop while tuning)
//
// Playwright's own Chromium is used deliberately: the system Chrome dies with
// `Trace/BPT trap: 5` on this host and playwright-cli hits an internal assertion,
// so this is the only working capture path.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// Screenshots are read back through an image pipeline that rejects anything over
// 2000px on either side in a multi-image request, and a fullPage capture blows
// past that instantly. Downscale on the way out with sips (macOS, always present)
// so every frame written here is readable.
import { execFileSync } from 'node:child_process';
function cap(path, max = 1900) {
  try { execFileSync('sips', ['-Z', String(max), path], { stdio: 'ignore' }); } catch {}
}


const SIZES = [
  ['5120x1440', 5120, 1440, 0.32],  // the user's 32:9 monitor
  ['3840x1080', 3840, 1080, 0.42],  // 32:9 at the other common panel size
  ['2560x1080', 2560, 1080, 0.62],  // 21:9 ultrawide
  ['1920x1080', 1920, 1080, 1],     // most common desktop
  ['1440x900',  1440, 900,  1],     // the size the layout was arranged at
  ['1366x768',  1366, 768,  1],     // most common laptop
  ['1024x768',  1024, 768,  1],     // narrow + tall extreme
  ['390x844',   390,  844,  1],     // phone
];

const only = process.argv[2];
const url = process.env.SHOOT_URL ?? 'http://127.0.0.1:3000/';
const out = 'ss';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const problems = [];

async function open(width, height, deviceScaleFactor) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await ctx.newPage();
  // skip the pour loader so we capture the page, not the intro
  await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${width}] ${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', e => problems.push(`[${width}] pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { ctx, page };
}

// ---- hero, every size ----
for (const [name, width, height, dsf] of SIZES) {
  const { ctx, page } = await open(width, height, dsf);
  await page.screenshot({ path: `${out}/hero-${name}.png` }); cap(`${out}/hero-${name}.png`);

  // the buffalo variant has never been looked at — switch and shoot it too
  const dots = page.locator('.vh-switch button');
  if (await dots.count() > 1) {
    await dots.nth(1).click();
    await page.waitForTimeout(1400);           // SWITCH_MS is 900 + stagger
    await page.screenshot({ path: `${out}/hero-${name}-buffalo.png` }); cap(`${out}/hero-${name}-buffalo.png`);
  }
  console.log(`hero ${name}  ok`);
  await ctx.close();
}

if (only !== 'hero') {
  // ---- the rest of the page, at the two aspects that matter ----
  for (const [name, width, height, dsf] of [
    ['5120x1440', 5120, 1440, 0.30],
    ['1440x900', 1440, 900, 0.55],
  ]) {
    const { ctx, page } = await open(width, height, dsf);

    // The story pillars and the drawn line are scroll-driven, so a screenshot taken
    // without scrolling shows them in their pre-reveal state and looks broken for
    // the wrong reason. Sweep the page first, then come back to the top.
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.6;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 400));
    });

    // whole page in one frame, to judge rhythm and section widths
    await page.screenshot({ path: `${out}/page-${name}.png`, fullPage: true }); cap(`${out}/page-${name}.png`);

    // each section on its own, so a broken one is legible
    const sections = await page.locator('section, footer').all();
    for (let i = 0; i < sections.length; i++) {
      const el = sections[i];
      const cls = (await el.getAttribute('class')) ?? `section-${i}`;
      const tag = cls.trim().split(/\s+/)[0].replace(/[^a-z0-9-]/gi, '') || `section-${i}`;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(450);
      // the story path follows the pointer, so give it a pointer to follow
      await page.mouse.move(width * 0.5, height * 0.55);
      await page.mouse.move(width * 0.62, height * 0.42, { steps: 12 });
      await page.waitForTimeout(350);
      await el.screenshot({ path: `${out}/sec-${name}-${i}-${tag}.png` }).then(() => cap(`${out}/sec-${name}-${i}-${tag}.png`)).catch(e =>
        problems.push(`[${width}] could not shoot section ${i} (${tag}): ${e.message.slice(0, 120)}`));
      console.log(`sec ${name} ${i} ${tag}  ok`);
    }
    await ctx.close();
  }
}

await browser.close();
console.log('\n--- console / page problems ---');
console.log(problems.length ? [...new Set(problems)].join('\n') : '(none)');
