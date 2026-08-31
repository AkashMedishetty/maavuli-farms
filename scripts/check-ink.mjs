/**
 * Generic invisible-ink sweep.
 *
 * This replaces a hand-written list of selectors, which is what let the bug recur
 * four times: the panel system inverted the page (white page, inset red panels) but
 * component CSS kept painting ink in `--milk`. Inside a panel that is white on red
 * and correct; outside it is white on white. Each time, the fix was applied only to
 * the selectors someone had thought to list — and the next component to be authored
 * against `--milk` was invisible again. The Continue button on the subscribe address
 * step was the fourth instance.
 *
 * So this walks EVERY element that paints text or a border, resolves the background
 * it actually sits on, and flags anything whose ink is indistinguishable from its
 * ground. No selector list to keep in sync.
 *
 *   node scripts/check-ink.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';

/** Pages, and how to reach any state that needs interaction first. */
const PAGES = [
  { path: '/' },
  { path: '/our-farm' },
  { path: '/plans' },
  { path: '/contact' },
  { path: '/account' },
  { path: '/legal/terms' },
  { path: '/legal/privacy' },
  { path: '/legal/refunds' },
  { path: '/legal/shipping' },
  { path: '/subscribe' },
  {
    path: '/subscribe',
    label: '/subscribe (address step)',
    async reach(page) {
      await page.locator('input').first().fill('500047');
      await page.getByRole('button', { name: /check/i }).first().click();
      await page.waitForTimeout(1200);
      for (let i = 0; i < 3; i++) {
        const cards = page.locator('.sb-choice, button[class*=choice], .sb-opt');
        if (await cards.count()) {
          await cards.first().click();
          await page.waitForTimeout(650);
        }
      }
    },
  },
];

const SWEEP = `(() => {
  const parse = (c) => {
    const m = String(c).match(/[\\d.]+/g);
    if (!m) return null;
    const [r, g, b, a] = [ +m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3] ];
    return { r, g, b, a };
  };
  // Effective background: walk up until something is not transparent.
  const groundOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    const c = parse(getComputedStyle(document.body).backgroundColor);
    return c && c.a > 0.5 ? c : { r: 255, g: 255, b: 255, a: 1 };
  };
  const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

  const problems = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue;

    const ground = groundOf(el);
    const label = (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
    const text = (el.textContent || '').trim().slice(0, 30);

    // ink: only judge elements that actually render their OWN text
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (ownText) {
      const ink = parse(s.color);
      if (ink && ink.a > 0.25 && dist(ink, ground) < 40) {
        problems.push({ kind: 'text', el: label, text, ink: s.color, ground: 'rgb(' + ground.r + ',' + ground.g + ',' + ground.b + ')' });
      }
    }
    // borders: an invisible border is how the buttons and cards disappeared
    for (const side of ['Top','Right','Bottom','Left']) {
      const w = parseFloat(s['border' + side + 'Width']);
      if (!w || s['border' + side + 'Style'] === 'none') continue;
      const bc = parse(s['border' + side + 'Color']);
      // A border matching the element's OWN fill is a redundant outline, not a
      // hidden one — e.g. a completed step chip that is solid red with a red edge.
      const own = parse(s.backgroundColor);
      const flatFill = own && own.a > 0.5 && dist(bc ?? { r: 0, g: 0, b: 0 }, own) < 20;
      if (bc && bc.a > 0.25 && !flatFill && dist(bc, ground) < 30) {
        problems.push({ kind: 'border', el: label, text, ink: s['border' + side + 'Color'], ground: 'rgb(' + ground.r + ',' + ground.g + ',' + ground.b + ')' });
      }
      break;
    }
  }
  // de-duplicate by element signature
  const seen = new Set();
  return problems.filter(p => { const k = p.kind + p.el + p.ink; if (seen.has(k)) return false; seen.add(k); return true; });
})()`;

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });

let total = 0;
for (const spec of PAGES) {
  const label = spec.label ?? spec.path;
  await page.goto(BASE + spec.path, { waitUntil: 'networkidle' });
  if (spec.reach) await spec.reach(page);
  await page.waitForTimeout(400);

  const found = await page.evaluate(SWEEP);
  if (found.length === 0) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}  — ${found.length} invisible`);
    for (const f of found.slice(0, 8)) {
      console.log(`          ${f.kind.padEnd(6)} ${f.el.slice(0, 34).padEnd(34)} ink ${f.ink} on ${f.ground}  "${f.text}"`);
    }
    total += found.length;
  }
}
await b.close();
console.log(`\n${total === 0 ? 'ALL PAGES PASS — no ink matches its own background' : total + ' invisible element(s)'}`);
process.exit(total ? 1 : 0);
