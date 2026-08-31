/**
 * Log into /admin the way a human does, exercise the zone editor's API, and prove
 * geo serviceability answers correctly. Then screenshot the panel.
 *
 *   node --env-file-if-exists=.env.local scripts/admin-walkthrough.mjs
 *
 * Admin access is an env allowlist of mobiles (ADMIN_MOBILES) re-checked
 * server-side on every request — a session that merely claims isAdmin is not
 * trusted — so this signs in as an allowlisted mobile through the real OTP flow.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3000';
const ADMIN = (process.env.ADMIN_MOBILES ?? '').split(',')[0]?.trim();
const OUTSIDER = '9000000002';

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`   ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};
const cap = p => { try { execFileSync('sips', ['-Z', '1900', p], { stdio: 'ignore' }); } catch {} };

async function signIn(page, mobile) {
  const req = await page.request.post(`${BASE}/api/auth/request`, { data: { mobile } });
  const body = await req.json();
  if (!body.devCode) throw new Error(`no devCode for ${mobile}: ${JSON.stringify(body)}`);
  const ver = await page.request.post(`${BASE}/api/auth/verify`, {
    data: { mobile, code: body.devCode },
  });
  if (!ver.ok()) throw new Error(`verify failed for ${mobile}: ${ver.status()}`);
  return body.devCode;
}

const b = await chromium.launch();

try {
  if (!ADMIN) { console.log('ADMIN_MOBILES is empty — admin is unreachable by design.'); process.exit(1); }
  console.log(`\n1. sign in as the allowlisted admin mobile ${ADMIN}`);
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });
  const code = await signIn(page, ADMIN);
  check('OTP issued and verified', Boolean(code), `code ${code}`);

  console.log('\n2. a non-allowlisted mobile must be refused');
  const ctx2 = await b.newContext();
  const page2 = await ctx2.newPage();
  await signIn(page2, OUTSIDER);
  const denied = await page2.request.get(`${BASE}/api/admin/zones`);
  check('outsider gets 403 on the zones API', denied.status() === 403, `status ${denied.status()}`);
  await ctx2.close();

  console.log('\n3. zone create / list / toggle / delete');
  const bad = await page.request.post(`${BASE}/api/admin/zones`, {
    data: { name: 'nonsense', lat: 91, lng: 0, radiusM: 3000 },
  });
  check('an out-of-range latitude is rejected', bad.status() === 400, `status ${bad.status()}`);

  const badR = await page.request.post(`${BASE}/api/admin/zones`, {
    data: { name: 'too big', lat: 17.4735, lng: 78.5468, radiusM: 900000 },
  });
  check('an absurd radius is rejected', badR.status() === 400, `status ${badR.status()}`);

  const made = await page.request.post(`${BASE}/api/admin/zones`, {
    data: { name: 'Safilguda morning round', lat: 17.4735, lng: 78.5468, radiusM: 4000 },
  });
  const madeBody = await made.json();
  check('zone created', made.status() === 200 && Boolean(madeBody.id), JSON.stringify(madeBody).slice(0, 120));
  const zoneId = madeBody.id;

  console.log('\n4. geo serviceability answers from the zone');
  const inside = await page.request.get(`${BASE}/api/serviceability?lat=17.4800&lng=78.5500`);
  const insideBody = await inside.json();
  check('a point inside the 4km zone is serviceable', insideBody.serviceable === true, JSON.stringify(insideBody).slice(0, 160));
  check('the rider gets a maps link', typeof insideBody.mapsUrl === 'string', String(insideBody.mapsUrl).slice(0, 60));

  const outside = await page.request.get(`${BASE}/api/serviceability?lat=17.9000&lng=78.5500`);
  const outsideBody = await outside.json();
  check('a point 47km away is not serviceable', outsideBody.serviceable === false && !outsideBody.unknown, JSON.stringify(outsideBody).slice(0, 140));

  const garbage = await page.request.get(`${BASE}/api/serviceability?lat=&lng=`);
  check('empty coordinates are a 400, not a silent (0,0)', garbage.status() === 400, `status ${garbage.status()}`);

  const legacy = await page.request.get(`${BASE}/api/serviceability?pincode=500047`);
  check('the pincode path still works (no flag day)', legacy.status() === 200, `status ${legacy.status()}`);

  console.log('\n5. the admin panel renders with the map');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); // let OSM tiles arrive
  const tiles = await page.locator('.zone-map img.leaflet-tile').count();
  check('OpenStreetMap tiles loaded', tiles > 0, `${tiles} tiles`);
  check('the zone appears in the list', await page.locator('.zone-list li').count() > 0);
  const attribution = await page.locator('.leaflet-control-attribution').first().textContent().catch(() => '');
  check('OSM attribution present (required by their tile policy)', /OpenStreetMap/i.test(attribution ?? ''));
  await page.screenshot({ path: 'ss/admin-zones.png' });
  cap('ss/admin-zones.png');
  await page.screenshot({ path: 'ss/admin-full.png', fullPage: true });
  cap('ss/admin-full.png');
  console.log('   wrote ss/admin-zones.png and ss/admin-full.png');

  console.log('\n6. toggling a zone off makes us deliver nowhere again (fail-closed)');
  await page.request.patch(`${BASE}/api/admin/zones`, { data: { id: zoneId, active: false } });
  const afterOff = await (await page.request.get(`${BASE}/api/serviceability?lat=17.4800&lng=78.5500`)).json();
  check('with no active zone the answer is "not published", not "no"', afterOff.unknown === true, JSON.stringify(afterOff).slice(0, 140));

  const del = await page.request.delete(`${BASE}/api/admin/zones?id=${zoneId}`);
  check('zone deleted', del.status() === 200, `status ${del.status()}`);
  await ctx.close();
} finally {
  await b.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
