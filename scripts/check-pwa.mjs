// PWA installability + mobile checks. Everything here is a real fetch or a real
// registration in a real mobile-emulated browser.
import { chromium, devices } from 'playwright';
const BASE = 'http://127.0.0.1:3000';
let bad = 0;
const check = (l, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); if (!c) bad++; };

const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });
await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('\nmanifest');
const href = await page.locator('link[rel=manifest]').getAttribute('href');
check('manifest is linked', Boolean(href), String(href));
const mres = await page.request.get(BASE + href);
check('manifest fetches 200', mres.status() === 200, `status ${mres.status()}`);
const man = await mres.json();
for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'icons']) {
  check(`manifest has ${k}`, man[k] !== undefined);
}
check('display is standalone', man.display === 'standalone', man.display);
const png = (man.icons ?? []).filter(i => i.type === 'image/png');
check('has PNG icons (SVG alone is not enough on Android)', png.length >= 2, `${png.length} png`);
check('has a maskable icon', (man.icons ?? []).some(i => (i.purpose ?? '').includes('maskable')));
check('has a 512px icon', (man.icons ?? []).some(i => (i.sizes ?? '').includes('512')));

console.log('\nicons actually resolve');
for (const i of man.icons ?? []) {
  const r = await page.request.get(BASE + i.src);
  check(`${i.src} -> ${r.status()}`, r.status() === 200);
}
const apple = await page.locator('link[rel="apple-touch-icon"]').first().getAttribute('href').catch(() => null);
check('apple-touch-icon declared (iOS ignores the manifest)', Boolean(apple), String(apple));
if (apple) {
  const r = await page.request.get(BASE + apple);
  check('apple-touch-icon resolves', r.status() === 200, `status ${r.status()}`);
}

console.log('\ntheme + viewport');
const theme = await page.locator('meta[name=theme-color]').first().getAttribute('content').catch(() => null);
check('theme-color meta present', theme === '#8c170e', String(theme));
const vp = await page.locator('meta[name=viewport]').first().getAttribute('content');
check('viewport is responsive', /width=device-width/.test(vp ?? ''), String(vp));
check('viewport-fit=cover for notched phones', /viewport-fit=cover/.test(vp ?? ''));

console.log('\nservice worker');
const reg = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  for (let i = 0; i < 40; i++) {
    const r = await navigator.serviceWorker.getRegistration();
    if (r) return r.active ? 'active' : 'registered';
    await new Promise(r2 => setTimeout(r2, 250));
  }
  return 'none';
});
check('service worker registers', reg === 'active' || reg === 'registered', reg);
const swRes = await page.request.get(BASE + '/sw.js');
check('sw.js served', swRes.status() === 200, `status ${swRes.status()}`);
const swBody = await swRes.text();
check('sw does NOT intercept /api/', swBody.includes("pathname.startsWith('/api/')"));
check('sw does NOT intercept /_next/', swBody.includes("pathname.startsWith('/_next/')"));

console.log('\nmobile page sanity');
check('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  await page.evaluate(() => `scrollW ${document.documentElement.scrollWidth} vs vw ${window.innerWidth}`));
check('hero visible', await page.locator('.vh').isVisible());
const tapTooSmall = await page.evaluate(() => {
  const els = [...document.querySelectorAll('a, button')];
  return els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 32 || r.width < 32); }).length;
});
check('tap targets are at least 32px', tapTooSmall === 0, `${tapTooSmall} too small`);

await ctx.close();
await b.close();
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
