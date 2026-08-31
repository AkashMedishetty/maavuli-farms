'use client';

import { useEffect, useRef } from 'react';
import { PILLARS, type Pillar } from '@/lib/content';
import { figure, cow, tree, tarpa, ground, render } from '@/lib/warli';

/**
 * One continuous line travels down the page and the reader draws it by scrolling.
 * Each pillar blossoms off that line as the front reaches it.
 *
 * The line is a single stretched path (preserveAspectRatio="none" — distorting a
 * curve is invisible), while the Warli art sits in the list items at true aspect.
 * Progress is computed in one rAF-throttled scroll handler; React never re-renders.
 */

const SEG = 460;

function serpentine(n: number, w = 400, seg = SEG): string {
  let d = `M${w / 2},0`;
  for (let i = 0; i < n; i++) {
    const y0 = i * seg;
    const y1 = y0 + seg;
    const dir = i % 2 === 0 ? 1 : -1;
    d += `C${w / 2 + dir * 175},${y0 + seg * 0.32} ${w / 2 + dir * 175},${y1 - seg * 0.32} ${w / 2},${y1}`;
  }
  return d;
}

/**
 * Composed scenes. Frozen concept: `kind` is typed as a plain string on purpose,
 * so this preserved variant does not break when the live Pillar art keys change.
 */
function artFor(kind: string): string | null {
  switch (kind) {
    case 'farmers':
      return (
        `<g transform="translate(70,10)">${render(figure({ armL: 104, bendL: -14, armR: 24 }), 4)}</g>` +
        `<g transform="translate(190,10) scale(.94)">${render(figure({ armL: 120, bendL: 60, armR: 120, bendR: 60 }), 4.2)}</g>` +
        `<g transform="translate(258,96) scale(.6)">${render(cow(), 5)}</g>`
      );
    case 'cows':
      return (
        `<g transform="translate(24,26) scale(.96)">${render(cow(), 4)}</g>` +
        `<g transform="translate(196,4) scale(.78)">${render(cow(), 4.6)}</g>` +
        `<g transform="translate(330,20) scale(.8)">${render(tree(), 4)}</g>` +
        `<g transform="translate(0,150)">${render(ground(400, 2, 28), 3)}</g>`
      );
    case 'doorstep':
      return (
        `<g transform="translate(66,6)">${render(figure({ armL: 118, bendL: 58, armR: 32, legL: 34, legR: -8 }), 4)}</g>` +
        // the doorstep: a threshold line, a bottle, and a kolam suggested beneath it
        `<path class="ws" d="M196,150L392,150" stroke-width="3"/>` +
        `<path class="wf" d="M282,86h20v10l7,14v40h-34V110l7-14Z"/>` +
        `<path class="ws" d="M232,168q16,-11 32,0q16,11 32,0q16,-11 32,0" stroke-width="2.6"/>`
      );
    case 'community':
      return `<g transform="translate(200,150)">${render(tarpa(9, 96), 3.4)}</g>`;
    case 'none':
    default:
      return null;
  }
}

const ART = PILLARS.map(p => ({ id: p.id, art: artFor(p.art) }));

export default function StoryPath() {
  const wrapRef = useRef<HTMLElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const itemsRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const path = pathRef.current;
    if (!wrap || !path) return;

    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      path.style.strokeDashoffset = '0';
      itemsRef.current?.querySelectorAll('li').forEach(li => li.classList.add('in'));
      return;
    }

    path.style.strokeDashoffset = String(len);
    const items = Array.from(itemsRef.current?.querySelectorAll('li') ?? []);
    let raf = 0;

    const update = () => {
      raf = 0;
      const r = wrap.getBoundingClientRect();
      // 0 when the section's top reaches mid-viewport, 1 when its bottom does
      const mid = window.innerHeight * 0.62;
      const p = Math.max(0, Math.min(1, (mid - r.top) / Math.max(1, r.height)));
      path.style.strokeDashoffset = String(len * (1 - p));
      for (const li of items) {
        const lr = li.getBoundingClientRect();
        if (lr.top < window.innerHeight * 0.82) li.classList.add('in');
      }
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const height = PILLARS.length * SEG;

  return (
    <section className="story" id="story" ref={wrapRef}>
      <svg
        className="story-path"
        viewBox={`0 0 400 ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path ref={pathRef} className="story-line" d={serpentine(PILLARS.length)} />
      </svg>

      <ol className="story-items" ref={itemsRef}>
        {PILLARS.map((p, i) => {
          const art = ART[i]?.art ?? null;
          return (
            <li key={p.id} className={art ? '' : 'quiet'}>
              <div className="story-text">
                <p className="eyebrow">{String(i + 1).padStart(2, '0')}</p>
                <h2>{p.title}</h2>
                <p>{p.body}</p>
              </div>
              {art ? (
                <svg className="story-art" viewBox="0 0 400 260" aria-hidden="true">
                  <g dangerouslySetInnerHTML={{ __html: art }} />
                </svg>
              ) : (
                // Absence has no icon. This section stays empty on purpose.
                <div className="story-art story-empty" aria-hidden="true">
                  <span />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
