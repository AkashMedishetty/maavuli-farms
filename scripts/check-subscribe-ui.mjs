// Walk the real subscribe flow in a browser, through the new details step.
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
const BASE = 'http://127.0.0.1:3000';
const cap = f => { try { execFileSync('sips', ['-Z', '1900', f], { stdio: 'ignore' }); } catch {} };
let bad = 0;
const check = (l, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); if (!c) bad++; };

const b = await chromium.launch();
for (const [label, opts] of [['desktop', { viewport: { width: 1440, height: 1000 } }], ['mobile', { ...devices['Pixel 7'] }]]) {
  console.log(`\n${label}`);
  // grant geolocation so the optional pin path can be exercised
  const ctx = await b.newContext({ ...opts, permissions: ['geolocation'], geolocation: { latitude: 17.4800, longitude: 78.5500 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });
  await page.goto(BASE + '/subscribe', { waitUntil: 'networkidle' });

  // step 1: pincode
  await page.locator('input').first().fill('500047');
  await page.getByRole('button', { name: /check/i }).first().click();
  await page.waitForTimeout(1200);

  // steps 2-4: pick the first option each time
  for (const stepName of ['milk', 'quantity', 'term']) {
    const cards = page.locator('.sb-choice, button[class*=choice], .sb-opt');
    const n = await cards.count();
    if (!n) { check(`${stepName}: options present`, false); break; }
    await cards.first().click();
    await page.waitForTimeout(700);
  }

  const onDetails = await page.locator('#sb-details-h').count();
  check('reached the details step', onDetails > 0);
  if (!onDetails) { await ctx.close(); continue; }

  // continue must be disabled until name + address are valid
  const cont = page.getByRole('button', { name: /continue to payment/i });
  check('Continue disabled with empty fields', await cont.isDisabled());
  await page.locator('.sb-field input').first().fill('Akash');
  await page.locator('.sb-field textarea').fill('Flat 3A');
  await page.waitForTimeout(200);
  check('still disabled with a too-short address', await cont.isDisabled());
  await page.locator('.sb-field textarea').fill('Flat 3A, Sai Residency, Balram Nagar, Safilguda');
  await page.locator('.sb-field input').nth(1).fill('opposite the water tank');
  await page.waitForTimeout(250);
  check('enabled once name and address are valid', !(await cont.isDisabled()));

  // optional pin
  await page.getByRole('button', { name: /use my current location/i }).click();
  await page.waitForTimeout(2500);
  const pinned = await page.locator('.sb-locbox .sb-help').allTextContents();
  check('location pinned', pinned.some(t => /Pinned to/i.test(t)), pinned.find(t => /Pinned/i.test(t))?.slice(0, 60) ?? pinned.join(' | ').slice(0, 70));
  const zone = await page.locator('.sb-locbox .sb-notice').first().textContent().catch(() => null);
  check('zone checked immediately', Boolean(zone), (zone ?? '').trim().slice(0, 70));

  await page.screenshot({ path: `ss/sub-details-${label}.png`, fullPage: true });
  cap(`ss/sub-details-${label}.png`);
  console.log(`  wrote ss/sub-details-${label}.png`);

  // and on to payment
  await cont.click();
  await page.waitForTimeout(1200);
  const atCheckout = await page.locator('body').textContent();
  check('reached the confirm/pay step', /prepaid|pay|sign in/i.test(atCheckout ?? ''));
  await ctx.close();
}
await b.close();
console.log(`\n${bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'}`);
process.exit(bad ? 1 : 0);
