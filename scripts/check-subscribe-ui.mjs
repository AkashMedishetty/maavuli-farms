// Walk the real three-screen subscribe flow in a headless browser and assert behaviour.
// No screenshots: every check reads the DOM, the URL or history.state.
//
//   MONGODB_DB=maavuli_test next dev -H 127.0.0.1 -p 3417      (in another shell)
//   SUBSCRIBE_BASE=http://127.0.0.1:3417 node scripts/check-subscribe-ui.mjs
//
// Needs a dev/test database with the dev zones (pnpm db:seed-dev) and no WhatsApp
// provider (the sign-in code is then shown on screen). It stops at the Pay button:
// no order is created and nothing is charged.
import { chromium, devices } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = process.env.SUBSCRIBE_BASE ?? 'http://127.0.0.1:3417';
const IN_ZONE = { latitude: 17.4741, longitude: 78.5475, accuracy: 10 }; // DEV Safilguda
const OUT_OF_ZONE = { latitude: 17.4401, longitude: 78.3489, accuracy: 10 }; // Gachibowli
const T = 90_000;

let bad = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) bad++;
};

const browser = await launch();

/** Playwright's own browser, else the newest headless shell already on this machine. */
async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const root = `${homedir()}/Library/Caches/ms-playwright`;
    const found = process.env.CHROMIUM_PATH
      ? [process.env.CHROMIUM_PATH]
      : (existsSync(root) ? readdirSync(root) : [])
          .filter((d) => d.startsWith('chromium_headless_shell-'))
          .sort()
          .reverse()
          .map((d) => `${root}/${d}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
          .filter((p) => existsSync(p));
    if (!found.length) throw err;
    console.log(`(using ${found[0]})`);
    return chromium.launch({ executablePath: found[0] });
  }
}

async function newPage(opts, geolocation) {
  const ctx = await browser.newContext({ ...opts, permissions: ['geolocation'], geolocation });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // map tiles and the favicon are not ours to judge here
    if (/tile\.openstreetmap|favicon|Failed to load resource/i.test(t)) return;
    errors.push(`console: ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
  });
  await page.addInitScript(() => {
    try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {}
  });
  page.setDefaultTimeout(T);
  return { ctx, page, errors };
}

const h1 = (page, name) => page.getByRole('heading', { level: 1, name });
const sbStep = (page) => page.evaluate(() => window.history.state?.sbStep ?? null);

/**
 * React is attached: the flow records its screen in history.state from an effect.
 * A tap on the server-rendered HTML before that does nothing, so every fresh load
 * waits for it before interacting.
 */
const hydrated = (page) => page.waitForFunction(() => window.history.state?.sbStep != null, null, { timeout: T });

/** Wait; on a timeout, print what the page was showing, then fail. */
async function waitOrExplain(page, locator, errors, what, ms = T) {
  try {
    await locator.waitFor({ timeout: ms });
  } catch (err) {
    const grab = async (sel) =>
      ((await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    console.log(`  FAIL waiting for ${what}`);
    console.log(`       url: ${page.url()}`);
    for (const sel of ['main.sb h1', '.lp-geo', '.lp-status', '.sb-areastate']) console.log(`       ${sel}: ${await grab(sel)}`);
    if (errors.length) console.log(`       errors: ${errors.slice(0, 5).join(' | ')}`);
    throw err;
  }
}

/* ------------------------------------------------------------ happy path -- */
console.log('\nphone (Pixel 7), in the delivery area');
{
  const { ctx, page, errors } = await newPage({ ...devices['Pixel 7'] }, IN_ZONE);
  await page.goto(`${BASE}/subscribe`, { waitUntil: 'domcontentloaded', timeout: T });
  await h1(page, 'Where should we deliver?').waitFor();
  await hydrated(page);
  check('screen 1 is the map', true);
  check('stepper shows three steps', (await page.locator('.sb-stepper li').count()) === 3);
  check('continue is disabled before a pin', await page.getByRole('button', { name: 'Next: choose your milk' }).isDisabled());
  check('prices are shown before anything is asked', /₹95 a litre.*₹115 a litre.*no auto-renewal/.test((await page.locator('.sb-priceline').textContent()) ?? ''));

  await page.getByRole('button', { name: /use my location/i }).click();
  await waitOrExplain(page, page.locator('.sb-areastate').getByText('We deliver here', { exact: true }), errors, 'the zone check (in the area)');
  const zoneText = ((await page.locator('.sb-areastate').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('zone check says yes, with the delivery window', /Milk arrives between .+ and .+ each morning/.test(zoneText), zoneText);
  check('no internal zone name is shown', !/DEV |TEST ZONE|·/.test(zoneText), zoneText);

  await page.getByLabel(/Name for the delivery/).fill('Anitha Rao');
  await page.getByLabel(/Flat \/ house/).fill('203');
  await page.getByLabel(/Floor/).fill('2');
  await page.getByLabel(/Society, building or street/).fill('Sai Residency, Balram Nagar');
  check('the address preview reads it back', await page.getByText('The delivery person will read:').isVisible());
  await page.getByRole('button', { name: 'Next: choose your milk' }).click();

  await h1(page, 'Your milk').waitFor();
  check('screen 2 is the plan', true);
  check('history entry marks the plan screen', (await sbStep(page)) === 'plan', String(await sbStep(page)));
  check('continue waits for all three choices', await page.locator('.sb-dock .sb-btn').isDisabled());

  await page.locator('label.sb-milk', { hasText: 'Buffalo' }).click();
  await page.locator('label.sb-opt', { hasText: '1 litre' }).click();
  await page.locator('label.sb-term', { hasText: '3 Months' }).click();
  const amt = (await page.locator('.sb-dock-amt').textContent())?.trim();
  check('price bar shows the quote', amt === '₹8,122.50', amt);
  check('term rows show pause days and per-litre', await page.locator('label.sb-term', { hasText: 'pause up to 20 mornings' }).locator('text=₹90.25 a litre').isVisible());
  await page.getByText(/Orders close at .+ the day before, so this is the earliest we can start/).waitFor();
  check('first delivery date comes from the server', true);
  check('selected milk is filled (is-on)', (await page.locator('label.sb-milk.is-on').count()) === 1);

  // the phone's Back goes to the map, with the door details kept; Forward comes back
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await waitOrExplain(page, h1(page, 'Where should we deliver?'), errors, 'screen 1 after Back', 20_000);
  check('Back returns to screen 1', true);
  await waitOrExplain(page, page.locator('.sb-areastate').getByText('We deliver here', { exact: true }), errors, 'the zone check after Back');
  check('door details survive Back', (await page.getByLabel(/Name for the delivery/).inputValue()) === 'Anitha Rao');
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await waitOrExplain(page, h1(page, 'Your milk'), errors, 'screen 2 after Forward', 20_000);
  check('Forward returns to screen 2', true);

  // refresh keeps everything
  await page.reload({ waitUntil: 'domcontentloaded' });
  await h1(page, 'Your milk').waitFor();
  const amt2 = (await page.locator('.sb-dock-amt').textContent())?.trim();
  check('refresh keeps the screen and the plan', amt2 === '₹8,122.50', amt2);

  // …and Back still works after a refresh
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
  const backOk = await h1(page, 'Where should we deliver?').waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const landed = backOk ? '' : `landed on ${page.url()} · h1: ${await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => 'none')}`;
  check('after a refresh, Back still returns to screen 1', backOk, landed);
  if (backOk) {
    await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => null);
  } else {
    await page.goto(`${BASE}/subscribe`, { waitUntil: 'domcontentloaded', timeout: T });
    await hydrated(page);
  }
  await waitOrExplain(page, h1(page, 'Your milk'), errors, 'screen 2 again', 30_000);

  await page.locator('.sb-dock .sb-btn').click();
  await h1(page, 'Check and pay').waitFor();
  check('screen 3 is the receipt', true);
  check('receipt total before sign-in', (await page.locator('.sb-receipt-total b').first().textContent())?.trim() === '₹8,122.50');
  await page.locator('.sb-receipt').getByText('→').waitFor();
  check('receipt shows the server dates', true);
  check('no map coordinates on the receipt', !(await page.locator('.sb-receipt').textContent()).match(/\d{2}\.\d{4,}/));
  await page.getByRole('heading', { name: 'Confirm your mobile number' }).waitFor();
  check('sign-in comes last', true);

  await page.getByLabel('Your mobile number').fill('9800000101');
  await page.getByRole('button', { name: 'Send code' }).click();
  const hint = page.getByText(/your code is \d{6}/);
  await hint.waitFor();
  const code = (await hint.textContent()).match(/(\d{6})/)?.[1];
  await page.getByLabel(/6-digit code/).fill(code ?? '');
  await page.getByText(/Signed in as \+91 98000 00101/).waitFor();
  check('six digits sign in without an extra tap', true);
  const payBtn = page.getByRole('button', { name: /^Pay ₹8,122\.50$/ });
  await payBtn.waitFor();
  check('pay button carries the amount', await payBtn.isVisible());

  // edit from the receipt, then come straight back to pay
  await page.getByRole('button', { name: /Edit address/ }).click();
  await h1(page, 'Where should we deliver?').waitFor();
  const next = page.getByRole('button', { name: 'Continue to pay' });
  await next.waitFor();
  check('after an edit, Continue goes back to pay', true);
  await next.click();
  await h1(page, 'Check and pay').waitFor();
  check('…and lands on the receipt', true);

  check('no page or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* --------------------------------------------------------- out of area -- */
console.log('\nphone, outside every delivery zone');
{
  const { ctx, page, errors } = await newPage({ ...devices['Pixel 7'] }, OUT_OF_ZONE);
  await page.goto(`${BASE}/subscribe`, { waitUntil: 'domcontentloaded', timeout: T });
  await h1(page, 'Where should we deliver?').waitFor();
  await hydrated(page);
  await page.getByRole('button', { name: /use my location/i }).click();
  await waitOrExplain(page, page.getByText(/We don.t deliver to this spot yet/), errors, 'the zone check (outside the area)');
  check('says so plainly', true);
  check('offers a call', await page.getByRole('link', { name: /^Call / }).isVisible());
  check('offers an email with the location', (await page.getByRole('link', { name: 'Email us your location' }).getAttribute('href'))?.includes('google.com%2Fmaps') === true);
  check('no door form outside the area', (await page.getByLabel(/Name for the delivery/).count()) === 0);
  check('no dead Continue button outside the area', (await page.getByRole('button', { name: 'Next: choose your milk' }).count()) === 0);
  check('no page or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------------------------------------------------------------- desktop -- */
console.log('\ndesktop 1440');
{
  const { ctx, page, errors } = await newPage({ viewport: { width: 1440, height: 900 } }, IN_ZONE);
  await page.goto(`${BASE}/subscribe`, { waitUntil: 'domcontentloaded', timeout: T });
  await h1(page, 'Where should we deliver?').waitFor();
  await hydrated(page);
  check('summary rail is shown on desktop', await page.locator('.sb-rail').isVisible());
  check('no page or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${bad ? `${bad} FAILED` : 'all checks passed'}`);
process.exit(bad ? 1 : 0);
