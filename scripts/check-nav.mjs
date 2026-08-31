// Mobile nav must work on EVERY page, not just the homepage.
//
// This uses elementFromPoint rather than isVisible(): a sheet clipped away by an
// ancestor's `overflow: hidden` still reports visible with a real bounding box,
// which is exactly how this bug survived an earlier check.
import { chromium, devices } from 'playwright';
const BASE = 'http://127.0.0.1:3000';
let bad = 0;
const check = (l, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); if (!c) bad++; };

const b = await chromium.launch();
for (const dev of ['Pixel 7', 'iPhone 13']) {
  console.log(`\n${dev}`);
  const ctx = await b.newContext({ ...devices[dev] });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });

  for (const path of ['/', '/our-farm', '/plans', '/subscribe', '/account', '/legal/terms']) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const burger = page.locator('.vnav-burger');
    if (!(await burger.count())) { check(`${path} has a mobile nav trigger`, false); continue; }
    await burger.click();
    await page.waitForTimeout(420);

    const r = await page.evaluate(() => {
      const link = document.querySelector('.vnav-sheet a');
      if (!link) return { ok: false, why: 'no link' };
      const b = link.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return { ok: false, why: 'zero size' };
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      if (cy < 0 || cy > window.innerHeight) return { ok: false, why: `offscreen y=${Math.round(cy)}` };
      // the real test: is the link the thing actually at its own coordinates?
      const hit = document.elementFromPoint(cx, cy);
      const reachable = hit === link || link.contains(hit) || hit?.contains(link);
      return { ok: reachable, why: reachable ? '' : `covered/clipped by .${(hit?.className || hit?.tagName || '?').toString().slice(0, 24)}`, href: link.getAttribute('href') };
    });
    check(`${path} menu link is actually reachable`, r.ok, r.ok ? String(r.href) : r.why);

    // and tapping it must navigate
    // Pick a link that is NOT the current page — the first item is "Home", so on /
    // clicking it cannot change the URL and proves nothing.
    if (r.ok) {
      const target = page.locator(`.vnav-sheet a:not([href="${path}"])`).first();
      if (await target.count()) {
        const href = await target.getAttribute('href');
        await target.click();
        await page.waitForTimeout(800);
        check(`${path} menu navigates to ${href}`, page.url().includes(href ?? '#'), page.url().replace(BASE, '') || '/');
      }
    }
  }
  await ctx.close();
}
await b.close();
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
