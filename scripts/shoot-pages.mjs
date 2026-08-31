// Capture inner pages full-length, so page-level layout can be judged too.
import { chromium } from 'playwright';

// Screenshots are read back through an image pipeline that rejects anything over
// 2000px on either side in a multi-image request, and a fullPage capture blows
// past that instantly. Downscale on the way out with sips (macOS, always present)
// so every frame written here is readable.
import { execFileSync } from 'node:child_process';
function cap(path, max = 1900) {
  try { execFileSync('sips', ['-Z', String(max), path], { stdio: 'ignore' }); } catch {}
}

const b = await chromium.launch();
const targets = process.argv.slice(2);
for (const t of (targets.length ? targets : ['plans', 'subscribe', 'account', 'contact'])) {
  for (const [w, h, dsf] of [[1440, 900, 0.6], [5120, 1440, 0.3]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    const p = await c.newPage();
    await p.addInitScript(() => { try { sessionStorage.setItem('mv-skip-loader', '1'); } catch {} });
    await p.goto(`http://127.0.0.1:3000/${t}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    await p.screenshot({ path: `ss/pg-${t}-${w}.png`, fullPage: true }); cap(`ss/pg-${t}-${w}.png`);
    console.log(`${t} ${w}  ok`);
    await c.close();
  }
}
await b.close();
