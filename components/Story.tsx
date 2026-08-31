'use client';

import { useEffect, useRef } from 'react';
import { PILLARS } from '@/lib/content';
import { WARLI } from '@/lib/generated/art';

/**
 * The five traced Warli panels, on the client's own mapping, threaded by one line
 * that the reader draws by scrolling.
 *
 * Two things worth knowing about the implementation:
 *
 * · The traced SVGs arrived with their own <style> blocks using identical .edge /
 *   .ink classes. Those are stripped in scripts/extract-art.mjs, so what lands
 *   here is bare path data and THIS component decides when each one draws.
 *
 * · Every path carries pathLength="1", which normalises its length. That means
 *   stroke-dasharray/offset work in units of 1 and the draw-on is pure CSS — no
 *   getTotalLength() measurement, nothing to go stale on resize.
 */

const SEG = 520;

function serpentine(n: number, w = 400, seg = SEG): string {
  let d = `M${w / 2},0`;
  for (let i = 0; i < n; i++) {
    const y0 = i * seg;
    const y1 = y0 + seg;
    const dir = i % 2 === 0 ? 1 : -1;
    d += `C${w / 2 + dir * 178},${y0 + seg * 0.32} ${w / 2 + dir * 178},${y1 - seg * 0.32} ${w / 2},${y1}`;
  }
  return d;
}

export default function Story() {
  const wrapRef = useRef<HTMLElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const line = lineRef.current;
    if (!wrap || !line) return;

    const items = Array.from(listRef.current?.querySelectorAll('li') ?? []);

    /* Opt in to the hidden-until-revealed state only now that the script is
       running. Without this the CSS hides the pillars unconditionally and a failed
       or blocked script leaves the section empty. */
    wrap.classList.add('story-js');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      line.style.strokeDashoffset = '0';
      items.forEach(li => li.classList.add('in'));
      return;
    }

    let raf = 0;
    const paint = () => {
      raf = 0;
      const r = wrap.getBoundingClientRect();
      const mid = window.innerHeight * 0.6;
      const p = Math.max(0, Math.min(1, (mid - r.top) / Math.max(1, r.height)));
      line.style.strokeDashoffset = String(1 - p);
      for (const li of items) {
        if (li.getBoundingClientRect().top < window.innerHeight * 0.78) li.classList.add('in');
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    paint();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <section className="story" id="story" ref={wrapRef}>
      <div className="wrap">
      <div className="story-head">
        <p className="eyebrow">How Maavuli works</p>
        <h2>Five things we will not cut corners on.</h2>
      </div>

      <svg
        className="story-path"
        viewBox={`0 0 400 ${PILLARS.length * SEG}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          ref={lineRef}
          className="story-line"
          d={serpentine(PILLARS.length)}
          pathLength={1}
        />
      </svg>

      <ol className="story-items" ref={listRef}>
        {PILLARS.map((p, i) => {
          const art = WARLI[p.art];
          return (
            <li key={p.id}>
              <div className="story-text">
                <p className="eyebrow">{String(i + 1).padStart(2, '0')}</p>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
              <div className="story-artwrap">
                <svg className="wart" viewBox={art.viewBox.join(' ')} aria-hidden="true">
                  {/* the outline draws, then the fill paints in — the order Warli is
                      actually made in: outline first, then filled with rice paste */}
                  <path className="wart-edge" d={art.path} pathLength={1} />
                  <path className="wart-ink" d={art.path} />
                </svg>
              </div>
            </li>
          );
        })}
      </ol>
      </div>
    </section>
  );
}
