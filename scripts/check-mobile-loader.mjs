/**
 * The loader path WITHOUT the skip flag — on a phone.
 *
 * This test exists because of a specific blind spot: every other capture and check
 * script sets `mv-skip-loader`, so the loader never actually ran in any of them.
 * That hid a scroll lock which affected literally every page load: `.loading body
 * { overflow: hidden }` combined with a `loading` class that was never removed.
 *
 * So nothing here may set the skip flag. It watches the real animation, then checks
 * the page is usable afterwards.
 */
import { chromium, devices } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
let bad = 0;
const check = (l, c, d = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`);
  if (!c) bad++;
};

const b = await chromium.launch();

for (const dev of ['Pixel 7', 'iPhone 13']) {
  console.log(`\n${dev} — loader runs for real (no skip flag)`);
  const ctx = await b.newContext({ ...devices[dev] });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // wait for the pour to actually start
  await page
    .waitForFunction(() => document.documentElement.classList.contains('loading'), undefined, { timeout: 9000 })
    .catch(() => {});
  const started = await page.evaluate(() => document.documentElement.classList.contains('loading'));
  check('loader starts', started);

  // while it plays, the mark must fit the screen and sit centred
  if (started) {
    const geo = await page.evaluate(() => {
      const svg = document.querySelector('.loader-svg');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), vw: window.innerWidth };
    });
    if (geo) {
      check('mark fits the viewport width', geo.w <= geo.vw, `svg ${geo.w}px vs vw ${geo.vw}px`);
      const centre = (geo.l + geo.r) / 2;
      check('mark is horizontally centred', Math.abs(centre - geo.vw / 2) <= 2, `centre ${centre} vs ${geo.vw / 2}`);
      check('mark does not hang off the left edge', geo.l >= -1, `left ${geo.l}`);
    } else {
      check('loader svg present', false);
    }
  }

  // let it finish and hand off
  await page.waitForFunction(() => document.documentElement.classList.contains('loaded'), undefined, { timeout: 12000 });
  await page.waitForTimeout(700);

  console.log(`${dev} — page must be usable afterwards`);
  const cls = await page.locator('html').getAttribute('class');
  check('`loading` class removed', !(cls ?? '').includes('loading'), `html class="${cls}"`);

  const overflow = await page.evaluate(() => getComputedStyle(document.body).overflowY);
  check('body scroll not locked', overflow !== 'hidden', `overflow-y: ${overflow}`);

  // the real test: can a human scroll?
  const scrolled = await page.evaluate(async () => {
    const before = window.scrollY;
    window.scrollTo(0, 900);
    await new Promise(r => setTimeout(r, 350));
    const after = window.scrollY;
    return { before, after, height: document.documentElement.scrollHeight, vh: window.innerHeight };
  });
  check('the page actually scrolls', scrolled.after > scrolled.before + 50,
    `y ${scrolled.before} -> ${scrolled.after} (page ${scrolled.height}px tall, viewport ${scrolled.vh}px)`);

  // and touch scrolling specifically, which is what the user reported
  const touchScrolled = await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 200));
    return getComputedStyle(document.documentElement).overflowY;
  });
  check('html not locked either', touchScrolled !== 'hidden', `overflow-y: ${touchScrolled}`);

  await ctx.close();
}

await b.close();
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
