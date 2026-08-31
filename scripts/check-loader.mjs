// The loader must play on EVERY load, not once per session.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:3000';
let bad = 0;
const check = (l, c, d='') => { console.log(`  ${c?'ok  ':'FAIL'} ${l}${d?'  '+d:''}`); if(!c) bad++; };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

async function loaderRan() {
  // <html> gains `loading` while the pour plays and `loaded` when it hands off.
  // The class is set in an effect after hydration, which in dev can take well over
  // a second — so WAIT for it rather than sampling at a fixed delay. Sampling too
  // early reports a working loader as broken.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () => document.documentElement.classList.contains('loading'),
      undefined,
      { timeout: 8000 },
    );
    return true;
  } catch {
    return false;
  }
}

console.log('\nsame browser context (this is what used to break):');
check('1st load plays the loader', await loaderRan());
check('2nd load plays it again',   await loaderRan());
check('3rd load plays it again',   await loaderRan());

// and it must actually finish, not hang over the page
await page.waitForTimeout(6000);
const cls = await page.locator('html').getAttribute('class');
check('loader completes and hands off', (cls ?? '').includes('loaded'), `html class="${cls}"`);
check('hero is visible afterwards', await page.locator('.vh').isVisible());
await ctx.close();

console.log('\nreduced motion must still skip it:');
const rm = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const p2 = await rm.newPage();
await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(400);
const c2 = await p2.locator('html').getAttribute('class');
check('skipped under prefers-reduced-motion', !(c2 ?? '').includes('loading'), `html class="${c2}"`);
await rm.close();

console.log('\ntooling skip flag still works (so captures are not of the pour):');
const t = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p3 = await t.newPage();
await p3.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader','1'); } catch {} });
await p3.goto(BASE, { waitUntil: 'domcontentloaded' });
await p3.waitForTimeout(300);
const c3 = await p3.locator('html').getAttribute('class');
check('skipped for capture scripts', !(c3 ?? '').includes('loading'), `html class="${c3}"`);
await t.close();

await b.close();
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
