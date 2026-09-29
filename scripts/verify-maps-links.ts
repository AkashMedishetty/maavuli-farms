// Unit tests for lib/maps-links.ts — pure. Run: pnpm test:maps
import { MAX_STOPS_PER_LINK, MAX_URL_LENGTH, navigationLinks, stopNavigationUrl } from '../lib/maps-links.ts';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const pt = (i: number) => ({ lat: 17.39 + i * 0.001, lng: 78.52 + i * 0.001 });
const params = (url: string) => new URL(url).searchParams;

// single stop
const one = stopNavigationUrl({ lat: 17.3935, lng: 78.5231 });
t('single: base', one.startsWith('https://www.google.com/maps/dir/?api=1&'), one);
t('single: destination at 6 dp', params(one).get('destination') === '17.393500,78.523100');
t('single: no waypoints', !params(one).has('waypoints'));
t('single: two-wheeler', params(one).get('travelmode') === 'two-wheeler');
t('single: navigate', params(one).get('dir_action') === 'navigate');
t('single: no origin (uses the phone location)', !params(one).has('origin'));
t('single: comma encoded as %2C', one.includes('17.393500%2C78.523100'));

// empty
t('empty → no links', navigationLinks([]).length === 0);

// exactly 10 → one link, 9 waypoints + destination
const ten = Array.from({ length: 10 }, (_, i) => pt(i));
const l10 = navigationLinks(ten);
t('10 stops → 1 link', l10.length === 1);
const wp10 = params(l10[0]!).get('waypoints')!.split('|');
t('10 stops → 9 waypoints', wp10.length === 9, wp10.length);
t('10 stops → destination is the 10th', params(l10[0]!).get('destination') === '17.399000,78.529000');
t('waypoints keep order', wp10[0] === '17.390000,78.520000' && wp10[8] === '17.398000,78.528000');
t('pipe encoded as %7C', l10[0]!.includes('%7C'));

// 23 → 10 + 10 + 3
const many = Array.from({ length: 23 }, (_, i) => pt(i));
const l23 = navigationLinks(many);
t('23 stops → 3 links', l23.length === 3, l23.length);
t('batch 2 destination is stop 20', params(l23[1]!).get('destination') === '17.409000,78.539000');
t('batch 2 starts at stop 11', params(l23[1]!).get('waypoints')!.split('|')[0] === '17.400000,78.530000');
const last = params(l23[2]!);
t('last batch: 2 waypoints + destination', last.get('waypoints')!.split('|').length === 2);
t('last batch destination is stop 23', last.get('destination') === '17.412000,78.542000');

// every stop appears exactly once across batches, in order
const flattened = l23.flatMap(u => {
  const p = params(u);
  return [...(p.get('waypoints')?.split('|') ?? []), p.get('destination')!];
});
t('all 23 stops covered once, in order', JSON.stringify(flattened) === JSON.stringify(many.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)));

// 11 → 10 + 1 (a lone last stop gets its own single-stop link)
const l11 = navigationLinks(Array.from({ length: 11 }, (_, i) => pt(i)));
t('11 stops → 2 links', l11.length === 2);
t('lone last stop: no waypoints', !params(l11[1]!).has('waypoints'));

// custom batch size, bounds
t('batch 3 → 4 links for 10', navigationLinks(ten, 3).length === 4);
let threw = false;
try {
  navigationLinks(ten, MAX_STOPS_PER_LINK + 1);
} catch {
  threw = true;
}
t('batch over 10 rejected', threw);
threw = false;
try {
  stopNavigationUrl({ lat: Number.NaN, lng: 78 });
} catch {
  threw = true;
}
t('NaN coordinate rejected', threw);

// URL length: a full batch with negative coords is still well under the cap
const worst = Array.from({ length: 10 }, (_, i) => ({ lat: -89.123456 + i, lng: -179.123456 + i }));
t('full batch under 2048 chars', navigationLinks(worst)[0]!.length < MAX_URL_LENGTH, navigationLinks(worst)[0]!.length);

console.log(`maps-links: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
