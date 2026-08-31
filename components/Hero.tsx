'use client';

import { useEffect, useRef } from 'react';
import { BRAND } from '@/lib/content';
import { cow, tree, sun, ground, figure, render } from '@/lib/warli';

/**
 * Hero, built to the David Whyte Experience standard but not its mechanism.
 *
 * What that reference actually does on its landing: fragments of text revealed at
 * scroll waypoints, over a scene with real depth, behind a loading beat that earns
 * itself. What it costs: a WebGL payload behind a gate. We take the first and
 * refuse the second — this is a milk subscription for patchy 4G, and our visual
 * language is LINE ART, which SVG renders crisper and ~100x lighter than WebGL.
 *
 * Depth comes from four layers moving at different rates against scroll and
 * pointer. The static scene is built at module scope from pure functions, so it is
 * in the server HTML and paints before any JS runs.
 */

const VB = { w: 1200, h: 620 };
const GROUND_Y = 512;
const G = 1150;

/* four depth planes, far -> near */
const L_SKY = `<g transform="translate(958,196)">${render(sun(14, 26), 3.2)}</g>`;

const L_FAR = [
  `<g transform="translate(96,404) scale(.62)">${render(tree(), 5)}</g>`,
  `<g transform="translate(1042,412) scale(.5)">${render(tree(), 6)}</g>`,
  `<g transform="translate(880,470) scale(.44)">${render(cow(), 7)}</g>`,
].join('');

const L_MID = [
  `<g transform="translate(178,388)">${render(tree(), 3.4)}</g>`,
  `<g transform="translate(404,440)">${render(cow(), 3.4)}</g>`,
  `<g transform="translate(648,460) scale(.82)">${render(cow(), 4)}</g>`,
].join('');

const L_NEAR = [
  `<g transform="translate(300,416) scale(.92)">${render(figure({ armL: 118, bendL: 58, armR: 30, legL: 30 }), 4)}</g>`,
  `<g transform="translate(0,${GROUND_Y})">${render(ground(VB.w + 60, 2, 30), 3.2)}</g>`,
].join('');

/** Fragments, revealed one viewport at a time — the reference's core move. */
const FRAGMENTS = [
  BRAND.tagline,
  'Before the household wakes, a kolam goes down at the door.',
  'By the time it is finished, so is the milk round.',
] as const;

interface Drop { x: number; y: number; v: number; r: number; hit: number }

export default function Hero() {
  const rootRef = useRef<HTMLElement>(null);
  const dropsRef = useRef<SVGGElement>(null);
  const layers = useRef<Record<string, SVGGElement | null>>({});

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const frags = Array.from(root.querySelectorAll<HTMLElement>('[data-frag]'));
    if (reduced) {
      frags.forEach(f => f.classList.add('on'));
      return;
    }

    /* ---- ambient drops: one rAF loop writing into a single group ---- */
    const dense = window.innerWidth > 720;
    const drops: Drop[] = [];
    let last = performance.now();
    let spawnIn = 0.5;
    let raf = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      spawnIn -= dt;
      if (spawnIn <= 0) {
        drops.push({ x: 180 + Math.random() * (VB.w - 360), y: -20, v: 40, r: 4 + Math.random() * 4, hit: 0 });
        spawnIn = dense ? 1.1 + Math.random() * 1.6 : 2.3 + Math.random() * 2;
      }
      const parts: string[] = [];
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i]!;
        if (d.hit > 0) {
          d.hit += dt;
          if (d.hit > 0.9) { drops.splice(i, 1); continue; }
          const p = Math.min(1, d.hit / 0.9);
          parts.push(
            `<ellipse cx="${d.x.toFixed(1)}" cy="${GROUND_Y}" rx="${(d.r * (1 + p * 7)).toFixed(1)}" ` +
            `ry="${(d.r * 0.5 * (1 - p)).toFixed(2)}" opacity="${((1 - p) * 0.5).toFixed(2)}"/>`
          );
          continue;
        }
        d.v += G * dt;
        d.y += d.v * dt;
        if (d.y >= GROUND_Y) { d.y = GROUND_Y; d.hit = 0.0001; }
        const s = Math.min(1, d.v / 700);
        parts.push(
          `<ellipse cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" ` +
          `rx="${(d.r * (1 - s * 0.32)).toFixed(2)}" ry="${(d.r * (1 + s * 0.85)).toFixed(2)}"/>`
        );
      }
      if (dropsRef.current) dropsRef.current.innerHTML = parts.join('');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    /* ---- scroll: fragment waypoints + layer parallax ---- */
    let sraf = 0;
    let px = 0, py = 0;

    const paint = () => {
      sraf = 0;
      const h = window.innerHeight;
      const p = window.scrollY / Math.max(1, h);          // 0..N viewports in

      frags.forEach((f, i) => {
        // each fragment owns one viewport of scroll and cross-fades out of it
        const d = p - i * 0.85;
        f.classList.toggle('on', d > -0.55 && d < 0.72);
        f.style.setProperty('--shift', `${(-d * 42).toFixed(1)}px`);
      });

      const set = (k: string, rate: number, extra = '') => {
        const el = layers.current[k];
        if (el) el.setAttribute('transform', `translate(${(px * rate * 26).toFixed(1)},${(-p * rate * 120 + py * rate * 14).toFixed(1)}) ${extra}`);
      };
      set('sky', 1.1);
      set('far', 0.34);
      set('mid', 0.62);
      set('near', 1);
      const skyEl = layers.current['sky'];
      if (skyEl) skyEl.style.opacity = String(Math.max(0.2, 1 - p * 0.7));
    };

    const onScroll = () => { if (!sraf) sraf = requestAnimationFrame(paint); };
    const onMove = (e: PointerEvent) => {
      px = (e.clientX / window.innerWidth - 0.5) * 2;
      py = (e.clientY / window.innerHeight - 0.5) * 2;
      onScroll();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    if (dense) window.addEventListener('pointermove', onMove, { passive: true });
    paint();

    return () => {
      cancelAnimationFrame(raf);
      if (sraf) cancelAnimationFrame(sraf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  const layer = (k: string, html: string, cls: string) => (
    <g
      ref={el => { layers.current[k] = el; }}
      className={cls}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );

  return (
    <header className="hero" ref={rootRef}>
      <div className="hero-stage">
        <svg
          className="hero-scene"
          viewBox={`0 0 ${VB.w} ${VB.h}`}
          preserveAspectRatio="xMidYMax slice"
          aria-hidden="true"
        >
          {layer('sky', L_SKY, 'l-sky')}
          {layer('far', L_FAR, 'l-far')}
          {layer('mid', L_MID, 'l-mid')}
          {layer('near', L_NEAR, 'l-near')}
          <g ref={dropsRef} className="hero-drops" />
        </svg>

        <div className="hero-copy">
          <p className="eyebrow">{BRAND.fullName}</p>
          <div className="hero-frags">
            {FRAGMENTS.map((f, i) => (
              <h1 key={i} data-frag={i} className={`hero-frag${i === 0 ? ' on' : ''}`}>
                {f}
              </h1>
            ))}
          </div>
          <a className="cta hero-cta" href="#plans">Start a subscription</a>
        </div>

        <span className="hero-hint" aria-hidden="true">Scroll</span>
      </div>

      {/* scroll runway for the fragment sequence — the stage above is sticky */}
      <div className="hero-runway" aria-hidden="true" />
    </header>
  );
}
