'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Wordmark from './Wordmark';
import Nav from './Nav';
import {
  VARIANTS, ASSETS_READY, assetPath, SLOT_SIZE, LAYOUT, layoutVars,
  type Slot, type BreakPoint,
} from '@/lib/hero';
import { quote, formatINR } from '@/lib/pricing';
import { BRAND } from '@/lib/content';

/**
 * Hero rebuilt against measurements taken from the reference video, not from eye.
 *
 * GEOMETRY — scanline sampling of the 800x600 recording put the design card at
 * x 60→720, y 90→510, i.e. ~660x420. The original was almost certainly 1440x900,
 * so the video is a ~0.46x downscale and pixel-exactness is not recoverable from
 * it. What is recoverable is proportion, so every position below is a percentage
 * of the hero box — which is also what a responsive hero needs.
 *
 * TIMING — per-frame difference analysis (tblend=difference + signalstats YAVG)
 * found two transitions: 1.08→2.04s and 2.64→3.52s. So SWITCH_MS = 900.
 *
 * STAGGER — the difference values oscillate (45.5, 46.6, 45.5, 47.3, 45.5, 48.9)
 * and dip back to baseline between peaks. A single crossfade produces a smooth
 * bell curve; that sawtooth is separate elements entering on different frames. So
 * the switch is staggered per layer rather than one fade.
 *
 * Both variants stay mounted and stacked so the outgoing one can genuinely
 * cross-fade. React never re-renders during the transition; it is all CSS off a
 * data attribute.
 */

const SWITCH_MS = 900;

export default function MilkHero({ motion = true }: { motion?: boolean } = {}) {
  const [active, setActive] = useState(0);
  /* The switch is DIRECTIONAL: the outgoing composition leaves the way you came
     from and the incoming one arrives from the other side, so pressing "next"
     feels different from pressing "previous". That needs two things a plain
     cross-fade does not — which way we are travelling, and which slide is the one
     leaving. `leaving` is cleared once the transition is over so the waiting slide
     parks on the correct side for the next press. */
  const [dir, setDir] = useState(1);
  const [leaving, setLeaving] = useState<number | null>(null);
  // which layout set to use. Observed rather than assumed, so a resize re-reads it.
  const [bp, setBp] = useState<BreakPoint>('desktop');
  const rootRef = useRef<HTMLElement>(null);

  /* Which layout set to use, from the hero's OWN width — not the viewport's.
     The CSS uses a container query, so keying this off matchMedia would let the
     data and the styles disagree, and the 390px frame in /hero-lab would show a
     desktop layout while claiming to be mobile. */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      setBp(w > 0 && w <= 900 ? 'mobile' : 'desktop');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* pointer + scroll parallax, written to CSS custom props in one rAF */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Parallax is off in the editor: dragging against a target that follows the
    // pointer means every measurement is taken from a moving reference.
    if (!motion) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    let px = 0, py = 0, sy = 0;

    const paint = () => {
      raf = 0;
      root.style.setProperty('--px', px.toFixed(4));
      root.style.setProperty('--py', py.toFixed(4));
      root.style.setProperty('--sy', sy.toFixed(4));
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(paint); };

    const onMove = (e: PointerEvent) => {
      const r = root.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width - 0.5;
      py = (e.clientY - r.top) / r.height - 0.5;
      queue();
    };
    const onScroll = () => {
      sy = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight)));
      queue();
    };

    // pointer parallax is desktop-only: on touch there is no hover, and the
    // listener would fire on every scroll-drag for nothing
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (fine) window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll);
    };
  }, [motion]);

  /* `d` is the direction of travel, passed by the caller rather than inferred:
     with a wrap-around carousel, comparing indices gets the direction backwards
     exactly when it wraps. */
  const go = (n: number, d: number) => {
    const next = (n + VARIANTS.length) % VARIANTS.length;
    if (next === active) return;
    setDir(d);
    setLeaving(active);
    setActive(next);
  };

  // park the outgoing slide back on its waiting side once the switch has finished
  useEffect(() => {
    if (leaving === null) return;
    const t = setTimeout(() => setLeaving(null), SWITCH_MS);
    return () => clearTimeout(t);
  }, [leaving, active]);

  return (
    <header
      className="vh panel"
      ref={rootRef}
      style={{ ['--switch' as string]: `${SWITCH_MS}ms`, ['--dir' as string]: String(dir) }}
    >
      {/* fields stack so the colour genuinely cross-fades instead of tweening
          through an intermediate hue */}
      {VARIANTS.map((v, i) => (
        <div
          key={v.kind}
          className="vh-field"
          data-on={i === active || undefined}
          style={{ background: v.field }}
        />
      ))}

      <Nav />

      <div className="vh-stage">
        {VARIANTS.map((v, i) => (
          <div
            key={v.kind}
            className="vh-slide"
            data-on={i === active || undefined}
            data-out={i === leaving || undefined}
            style={layoutVars(LAYOUT[bp][v.kind])}
          >
            {/* Fixed-aspect box that scales to fit. Every layer sizes and positions
                against THIS, so the composition scales as one rigid unit instead of
                the bottle following height while the splash follows width. That
                divergence is why an arrangement fell apart on another screen. */}
            <div className="vh-comp">
            <Wordmark className="vh-word" />
            {ASSETS_READY ? (
              <>
                {(['splash', 'bottle', 'objects'] as Exclude<Slot, 'word'>[]).map(slot => {
                  const d = SLOT_SIZE[slot][v.kind];
                  const isHeroBottle = i === 0 && slot === 'bottle';
                  return (
                    <Image
                      key={slot}
                      className={`vh-${slot}`}
                      data-mirror={v.mirror.includes(slot) || undefined}
                      src={assetPath(slot, v.kind)}
                      alt={slot === 'bottle' ? `${v.name} in a glass bottle` : ''}
                      width={d.w}
                      height={d.h}
                      sizes="(max-width: 900px) 88vw, 74vw"
                      // only the first variant's bottle is worth blocking first paint on;
                      // everything else, including the whole second variant, waits
                      priority={isHeroBottle}
                      loading={isHeroBottle ? undefined : 'lazy'}
                      aria-hidden={slot === 'bottle' ? undefined : true}
                    />
                  );
                })}
              </>
            ) : (
              <Stand />
            )}
            </div>
          </div>
        ))}
      </div>

      {/* copy sits bottom-left, matching the reference's card position */}
      <div className="vh-copy">
        {VARIANTS.map((v, i) => (
          <div key={v.kind} className="vh-copy-slide" data-side={v.copySide} data-on={i === active || undefined} data-out={i === leaving || undefined}>
            <p className="eyebrow">{v.body}</p>
            <h1>{v.name}</h1>
            <p className="vh-line">{v.line}</p>
            <p className="vh-price">
              from <strong>{formatINR(quote(v.kind, 'one', '1y').perLitrePaise)}</strong> a litre
            </p>
            <Link className="cta" href={`/subscribe?milk=${v.kind}`}>
              Subscribe
            </Link>
          </div>
        ))}
      </div>

      {/* side arrows at mid-height, as in the reference */}
      <button className="vh-arrow vh-prev" onClick={() => go(active - 1, -1)} aria-label="Previous milk">
        ‹
      </button>
      <button className="vh-arrow vh-next" onClick={() => go(active + 1, 1)} aria-label="Next milk">
        ›
      </button>

      <div className="vh-switch" role="tablist" aria-label="Choose your milk">
        <span className="eyebrow">Choose yours</span>
        {VARIANTS.map((v, i) => (
          <button
            key={v.kind}
            role="tab"
            aria-selected={i === active}
            aria-label={v.name}
            className={i === active ? 'on' : undefined}
            style={{ ['--dot' as string]: v.field }}
            onClick={() => go(i, i > active ? 1 : -1)}
          >
            <span aria-hidden />
          </button>
        ))}
      </div>

      {!ASSETS_READY && (
        <p className="vh-flag">
          Geometry and timings measured from the reference · product art is a stand-in
          until renders land in <code>public/hero/</code>
        </p>
      )}
    </header>
  );
}

/** Stand-in at the real assets' exact boxes, so nothing shifts when they land. */
function Stand() {
  return (
    <svg className="vh-ph" viewBox="0 0 900 760" aria-hidden="true">
      <g className="ph-splash" fill="none" strokeWidth="2" strokeDasharray="7 9">
        <ellipse cx="450" cy="470" rx="368" ry="122" />
        <path d="M104 458q82-152 184-122M796 458q-82-152-184-122M238 396q40-122 132-152M662 396q-40-122-132-152" />
        <circle cx="148" cy="248" r="13" /><circle cx="762" cy="284" r="17" />
        <circle cx="286" cy="168" r="10" /><circle cx="614" cy="144" r="12" />
      </g>
      <g className="ph-bottle" strokeWidth="2.5" fill="none">
        <path d="M392 150h116v58l30 66v370a26 26 0 0 1-26 26H388a26 26 0 0 1-26-26V274l30-66Z" />
        <rect x="388" y="120" width="124" height="36" rx="7" />
        <rect x="392" y="330" width="116" height="150" rx="5" strokeDasharray="6 7" />
        <text x="450" y="415" textAnchor="middle" className="ph-label">label</text>
      </g>
      <g className="ph-objects" strokeWidth="2" fill="none" strokeDasharray="7 9">
        <path d="M120 620q40-50 96-30l-14 54q-52 6-82-24Z" />
        <path d="M742 596q-46-44-98-18l18 52q54 2 80-34Z" />
        <path d="M196 700q40-44 92-30M660 690q-40-40-92-26" />
      </g>
    </svg>
  );
}
