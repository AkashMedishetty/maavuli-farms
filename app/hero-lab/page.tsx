'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MilkHero from '@/components/MilkHero';

/**
 * Visual hero editor.
 *
 * Drag a layer to place it, wheel over it to size it, then copy the CSS.
 *
 * The whole point is that nothing is stored in pixels. A position dragged at
 * 1440px wide is meaningless at 390px, so every value written here is either a
 * PERCENTAGE OF THE STAGE (scales with width) or svh (scales with height). Drag
 * deltas are divided by the live stage box before being stored, which is what
 * makes a placement hold at every size.
 *
 * Breakpoints are edited separately because the right composition genuinely
 * differs — on a phone the bottle wants to be smaller and the wordmark wider. The
 * export emits a base block plus a max-width:900px override.
 */

type Layer = 'bottle' | 'splash' | 'objects' | 'word';
type BP = 'desktop' | 'mobile';

interface Geo {
  x: number;   // % of stage width
  y: number;   // % of stage height
  size: number; // bottle = svh, others = % of stage width
}

const DEFAULTS: Record<BP, Record<Layer, Geo>> = {
  desktop: {
    bottle:  { x: 0, y: 0,   size: 60 },
    splash:  { x: 0, y: -3,  size: 108 },
    objects: { x: 0, y: 12,  size: 116 },
    word:    { x: 0, y: 44,  size: 132 },
  },
  mobile: {
    bottle:  { x: 0, y: 0,   size: 40 },
    splash:  { x: 0, y: -2,  size: 122 },
    objects: { x: 0, y: 10,  size: 132 },
    word:    { x: 0, y: 36,  size: 190 },
  },
};

const LAYERS: Layer[] = ['splash', 'bottle', 'objects', 'word'];
const SEL: Record<Layer, string> = {
  bottle: '.vh-slide[data-on] .vh-bottle',
  splash: '.vh-slide[data-on] .vh-splash',
  objects: '.vh-slide[data-on] .vh-objects',
  word: '.vh-word',
};
const WIDTHS: Record<BP, number | null> = { desktop: null, mobile: 390 };

const r1 = (n: number) => Math.round(n * 10) / 10;

export default function HeroLab() {
  const [bp, setBp] = useState<BP>('desktop');
  const [geo, setGeo] = useState<Record<BP, Record<Layer, Geo>>>(DEFAULTS);
  const [sel, setSel] = useState<Layer>('bottle');
  const [alpha, setAlpha] = useState(0.17);
  const [outline, setOutline] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);

  /** push current geometry into the hero's custom properties */
  const apply = useCallback(() => {
    const hero = frameRef.current?.querySelector<HTMLElement>('.vh');
    if (!hero) return;
    const g = geo[bp];
    hero.style.setProperty('--bottle-h', `${g.bottle.size}svh`);
    hero.style.setProperty('--bottle-x', `${g.bottle.x}%`);
    hero.style.setProperty('--bottle-y', `${g.bottle.y}%`);
    for (const k of ['splash', 'objects', 'word'] as const) {
      hero.style.setProperty(`--${k}-w`, `${g[k].size}%`);
      hero.style.setProperty(`--${k}-x`, `${g[k].x}%`);
      hero.style.setProperty(`--${k}-y`, `${g[k].y}%`);
    }
    hero.style.setProperty('--word-alpha', String(alpha));
  }, [geo, bp, alpha]);

  useEffect(() => { apply(); }, [apply]);

  /* drag to place, wheel to size — measured against the LIVE stage box so the
     stored value is a proportion, never a pixel */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let active: Layer | null = null;
    let startX = 0, startY = 0, from: Geo | null = null, box = { w: 1, h: 1 };

    const hit = (t: EventTarget | null): Layer | null => {
      if (!(t instanceof Element)) return null;
      for (const l of LAYERS) if (t.closest(SEL[l])) return l;
      return null;
    };

    const onDown = (e: PointerEvent) => {
      const l = hit(e.target);
      if (!l) return;
      const stage = frame.querySelector('.vh');
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      box = { w: r.width, h: r.height };
      active = l; setSel(l);
      startX = e.clientX; startY = e.clientY;
      from = { ...geo[bp][l] };
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!active || !from) return;
      const dx = ((e.clientX - startX) / box.w) * 100;
      const dy = ((e.clientY - startY) / box.h) * 100;
      setGeo(g => ({ ...g, [bp]: { ...g[bp], [active!]: { ...from!, x: r1(from!.x + dx), y: r1(from!.y + dy) } } }));
    };
    const onUp = () => { active = null; from = null; };

    const onWheel = (e: WheelEvent) => {
      const l = hit(e.target);
      if (!l) return;
      e.preventDefault();
      setSel(l);
      const step = e.deltaY > 0 ? -1.5 : 1.5;
      setGeo(g => {
        const cur = g[bp][l];
        return { ...g, [bp]: { ...g[bp], [l]: { ...cur, size: r1(Math.max(4, cur.size + step)) } } };
      });
    };

    frame.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      frame.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      frame.removeEventListener('wheel', onWheel);
    };
  }, [bp, geo]);

  const css = buildCss(geo, alpha);
  const g = geo[bp][sel];
  const unit = sel === 'bottle' ? 'svh' : '%';

  return (
    <div className="lab">
      <div className={`lab-stage${outline ? ' outline' : ''}`}>
        <div
          className="lab-frame"
          ref={frameRef}
          style={WIDTHS[bp] ? { width: WIDTHS[bp]!, margin: '0 auto' } : undefined}
        >
          <MilkHero />
        </div>
      </div>

      <aside className="lab-panel">
        <strong>Hero editor</strong>
        <p className="lab-hint">
          Drag a layer to place it · wheel over it to resize · values are stored as %
          of the stage and svh, never pixels, so a placement holds at every size.
        </p>

        <label>Breakpoint</label>
        <div className="lab-seg">
          {(['desktop', 'mobile'] as BP[]).map(b => (
            <button key={b} className={b === bp ? 'on' : undefined} onClick={() => setBp(b)}>
              {b}{WIDTHS[b] ? ` ${WIDTHS[b]}px` : ''}
            </button>
          ))}
        </div>

        <label>Layer</label>
        <div className="lab-seg lab-seg-col">
          {LAYERS.map(l => (
            <button key={l} className={l === sel ? 'on' : undefined} onClick={() => setSel(l)}>
              {l}
            </button>
          ))}
        </div>

        <label>x <span>{g.x}%</span></label>
        <input type="range" min={-60} max={60} step={0.5} value={g.x}
               onChange={e => setGeo(s => ({ ...s, [bp]: { ...s[bp], [sel]: { ...g, x: +e.target.value } } }))} />
        <label>y <span>{g.y}%</span></label>
        <input type="range" min={-60} max={60} step={0.5} value={g.y}
               onChange={e => setGeo(s => ({ ...s, [bp]: { ...s[bp], [sel]: { ...g, y: +e.target.value } } }))} />
        <label>{sel === 'bottle' ? 'height' : 'width'} <span>{g.size}{unit}</span></label>
        <input type="range" min={sel === 'bottle' ? 15 : 30} max={sel === 'bottle' ? 95 : 260} step={0.5}
               value={g.size}
               onChange={e => setGeo(s => ({ ...s, [bp]: { ...s[bp], [sel]: { ...g, size: +e.target.value } } }))} />

        <label>wordmark opacity <span>{alpha.toFixed(2)}</span></label>
        <input type="range" min={0} max={0.6} step={0.01} value={alpha}
               onChange={e => setAlpha(+e.target.value)} />

        <label className="lab-check">
          <input type="checkbox" checked={outline} onChange={e => setOutline(e.target.checked)} />
          outline layers
        </label>

        <button className="lab-btn" onClick={() => setGeo(DEFAULTS)}>reset</button>
        <button className="lab-btn" onClick={() => navigator.clipboard?.writeText(css)}>
          copy CSS
        </button>

        <label>Bake this into app/hero.css</label>
        <textarea className="lab-out" readOnly value={css} rows={16} />
      </aside>
    </div>
  );
}

/** Emits a base block plus a mobile override — the shape hero.css already uses. */
function buildCss(geo: Record<BP, Record<Layer, Geo>>, alpha: number): string {
  const block = (g: Record<Layer, Geo>, indent: string) =>
    [
      `${indent}--bottle-h: ${g.bottle.size}svh;`,
      `${indent}--bottle-x: ${g.bottle.x}%;`,
      `${indent}--bottle-y: ${g.bottle.y}%;`,
      `${indent}--splash-w: ${g.splash.size}%;`,
      `${indent}--splash-x: ${g.splash.x}%;`,
      `${indent}--splash-y: ${g.splash.y}%;`,
      `${indent}--objects-w: ${g.objects.size}%;`,
      `${indent}--objects-x: ${g.objects.x}%;`,
      `${indent}--objects-y: ${g.objects.y}%;`,
      `${indent}--word-w: ${g.word.size}%;`,
      `${indent}--word-x: ${g.word.x}%;`,
      `${indent}--word-y: ${g.word.y}%;`,
    ].join('\n');

  return `.vh {\n${block(geo.desktop, '  ')}\n  --word-alpha: ${alpha.toFixed(2)};\n}\n\n@media (max-width: 900px) {\n  .vh {\n${block(geo.mobile, '    ')}\n  }\n}\n`;
}
