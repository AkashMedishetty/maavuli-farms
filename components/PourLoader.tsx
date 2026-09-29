'use client';

import { useEffect, useRef, useState } from 'react';
import { KOLAM } from '@/lib/generated/art';
import { BRAND } from '@/lib/content';

/**
 * One drop falls, forms the mark, the wordmark rises, then this hands off to the
 * homepage. Plays ONCE PER SESSION — a returning buyer should not be made to
 * watch it before they can order.
 *
 * The no-flash trick lives in the layout: an inline script adds `.loaded` to
 * <html> before first paint if the session has already seen this, and CSS hides
 * the overlay on that class. Without it, sessionStorage being client-only means
 * the loader flashes on every navigation.
 *
 * Timings are the ones tuned in assets/brand/pour-loader.html:
 * gravity 1050, drop size 13, stretch 60, goo 7, flood reveal.
 */

const CX = 270, TOP = -6, K_CY = 292, K_SIZE = 272, G = 1050;
const DROP = 13, STRETCH = 60;

const T = {
  swell: [0.0, 0.24],
  neck: [0.2, 0.3],
  drop: [0.26, 0.78],
  hit: [0.74, 0.88],
  form: [0.82, 2.2],
  word: [2.32, 2.94],
} as const;
const END = 2.94;
const OUT = 0.55; // fade to the homepage

const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (t: number, [a, b]: readonly [number, number]) => cl((t - a) / (b - a));
const outQ = (p: number) => 1 - (1 - p) * (1 - p);
const outC = (p: number) => 1 - Math.pow(1 - p, 3);
const backOut = (p: number, s = 2.2) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
const n1 = (v: number) => Math.round(v * 10) / 10;

const [VX, VY, VW, VH] = KOLAM.viewBox;
const SCALE = K_SIZE / Math.max(VW, VH);
const TX = CX - (VX + VW / 2) * SCALE;
const TY = K_CY - (VY + VH / 2) * SCALE;
const MARK_BOT = K_CY + (VH * SCALE) / 2;

export default function PourLoader() {
  const [gone, setGone] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<SVGGElement>(null);
  const pulliRef = useRef<SVGGElement>(null);
  const floodRef = useRef<SVGRectElement>(null);
  const wordRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const done = () => {
      /*
       * Removing `loading` is NOT cosmetic — `.loading body { overflow: hidden }`
       * locks the page scroll, and this class was previously only removed in the
       * effect's cleanup. That cleanup never runs: the loader hides itself by
       * returning null, which does not unmount the component, and the dependency
       * array is empty. So `loading` stayed on <html> for the life of the page and
       * the site could not be scrolled at all.
       *
       * It went unnoticed because every capture and test script sets
       * mv-skip-loader, which returns early before `loading` is ever added — the
       * tooling skipped the exact path that breaks.
       */
      document.documentElement.classList.remove('loading');
      document.documentElement.classList.add('loaded');
      setGone(true);
    };

    /*
     * The loader now plays on EVERY load, not once per session.
     *
     * It used to write sessionStorage['mv-loaded'] and skip on every subsequent
     * navigation, which made the pour effectively invisible — you saw it once and
     * never again, so it read as broken.
     *
     * The one remaining skip is `mv-skip-loader`, which ONLY the capture and test
     * scripts set. It is deliberately a different key from the old one: nothing in
     * the app writes it, so a real visitor can never end up in the skipped state by
     * accident, which is exactly how the old key silenced the animation.
     *
     * Reduced motion still skips, because a full-screen pour is precisely the kind
     * of motion that setting exists to suppress.
     */
    let skip = false;
    try { skip = sessionStorage.getItem('mv-skip-loader') === '1'; } catch { /* private mode */ }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // ?loader still forces a replay, so the animation can be re-watched on demand
    const forced = new URLSearchParams(window.location.search).has('loader');
    if ((skip || reduced) && !forced) { done(); return; }
    // The root layout's pre-paint script already marked the page `loaded` (the
    // /admin and /rider work tools, or the skip key), so the overlay is hidden:
    // do not run a ~3.5 s animation nobody can see on a rider's low-end phone.
    if (document.documentElement.classList.contains('loaded')) { done(); return; }

    document.documentElement.classList.add('loading');

    // Land on the topmost point of the actual ink — not the bounding box. A bbox
    // top sits above the ink wherever the mark is asymmetric, and that gap shows.
    const path = pathRef.current;
    let land = { x: CX, y: K_CY - (VH * SCALE) / 2 };
    if (path) {
      const L = path.getTotalLength();
      let best: DOMPoint | null = null;
      for (let i = 0; i <= 420; i++) {
        const p = path.getPointAtLength((L * i) / 420);
        if (!best || p.y < best.y) best = p;
      }
      if (best) land = { x: best.x * SCALE + TX, y: best.y * SCALE + TY };
    }
    const LAND = land.y + 2;
    const SX = land.x;

    const dots = [...KOLAM.dots]
      .map(d => ({ d, k: d.y }))
      .sort((a, b) => a.k - b.k)
      .map(o => o.d);

    let raf = 0;
    const t0 = performance.now();

    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const feed: string[] = [];

      if (t < T.neck[1]) {
        const sw = outQ(seg(t, T.swell));
        const nk = seg(t, T.neck);
        feed.push(`<circle cx="${n1(SX)}" cy="${n1(TOP + 9 + sw * 11 + nk * 13)}" r="${n1((3 + sw * DROP * 0.9) * (1 - nk * 0.22))}"/>`);
        if (nk > 0) feed.push(`<rect x="${n1(SX - 1.4)}" y="${TOP}" width="2.8" height="${n1(15 * (1 - nk))}" rx="1.4"/>`);
      }

      const dp = seg(t, T.drop);
      const hp = seg(t, T.hit);
      if (dp > 0 && hp < 1) {
        const dt = t - T.drop[0];
        const y = Math.min(LAND, TOP + 20 + 0.5 * G * dt * dt);
        const v = Math.min(1, (G * dt) / 1000) * (STRETCH / 100);
        let rx = DROP * (1 - v * 0.34);
        let ry = DROP * (1 + v * 0.95);
        if (hp > 0) { rx = DROP * (1 + hp * 0.95); ry = DROP * (1 - hp * 0.8); }
        if (ry > 0.15) feed.push(`<ellipse cx="${n1(SX)}" cy="${n1(hp > 0 ? LAND : y)}" rx="${n1(rx)}" ry="${n1(ry)}"/>`);
      }
      if (feedRef.current) feedRef.current.innerHTML = feed.join('');

      // flood: the milk fills the mark downward from where it landed
      const mp = seg(t, T.form);
      if (floodRef.current) {
        floodRef.current.setAttribute('y', String(n1(land.y - 6)));
        floodRef.current.setAttribute('height', String(n1(outC(mp) * (MARK_BOT - (land.y - 6) + 14))));
      }
      if (pulliRef.current) {
        pulliRef.current.innerHTML = dots
          .map((d, i) => {
            const p = cl((outQ(mp) - (i / dots.length) * 0.72) / 0.28);
            return p <= 0
              ? ''
              : `<circle cx="${n1(d.x)}" cy="${n1(d.y)}" r="${n1(Math.max(0, d.r * backOut(p)))}"/>`;
          })
          .join('');
      }

      const wp = seg(t, T.word);
      if (wordRef.current) {
        wordRef.current.setAttribute('opacity', String(n1(outC(wp))));
        wordRef.current.setAttribute('transform', `translate(0,${n1((1 - outC(wp)) * 26)})`);
      }

      if (t >= END) {
        if (rootRef.current) rootRef.current.classList.add('out');
        window.setTimeout(done, OUT * 1000);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); document.documentElement.classList.remove('loading'); };
  }, []);

  if (gone) return null;

  return (
    <div className="loader" ref={rootRef} role="status" aria-label="Loading Maavuli Farm Milk">
      <svg className="loader-svg" viewBox="0 0 540 700" aria-hidden="true">
        <defs>
          <filter id="ldr-goo" x="-40%" y="-15%" width="180%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
            <feColorMatrix
              in="b"
              result="g"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"
            />
            <feBlend in="SourceGraphic" in2="g" />
          </filter>
          <mask id="ldr-flood">
            <rect ref={floodRef} x="0" y="0" width="540" height="0" fill="#fff" />
          </mask>
        </defs>

        <g mask="url(#ldr-flood)">
          {/* one transform, one source of truth — the line and the dots cannot drift */}
          <g transform={`translate(${TX.toFixed(4)},${TY.toFixed(4)}) scale(${SCALE.toFixed(6)})`}>
            <path
              ref={pathRef}
              d={KOLAM.path}
              fill="none"
              stroke="var(--milk)"
              strokeWidth={(3 / SCALE).toFixed(3)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <g ref={pulliRef} fill="var(--milk)" />
          </g>
        </g>

        <g ref={feedRef} filter="url(#ldr-goo)" fill="var(--milk)" />

        <g ref={wordRef} opacity="0" textAnchor="middle" fill="var(--milk)">
          <text x={CX} y={MARK_BOT + 104} className="ldr-word">{BRAND.name}</text>
          <text x={CX} y={MARK_BOT + 152} className="ldr-sub">Farm Milk</text>
        </g>
      </svg>
    </div>
  );
}
