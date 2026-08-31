'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MilkHero from '@/components/MilkHero';
import { LAYOUT, VARIANTS, type Layout, type Slot, type BreakPoint } from '@/lib/hero';
import type { MilkKind } from '@/lib/pricing';

/**
 * Free canvas.
 *
 * Drag anything anywhere, per variant and per breakpoint. Wheel over a layer to
 * size it. Nothing is anchored to anything and no side logic is imposed — "product
 * right for cow, left for buffalo" is just two different sets of numbers.
 *
 * Everything is stored as a share of the stage (or svh for the bottle), never a
 * pixel: drag deltas are divided by the live stage box before being stored, which
 * is what makes a placement dragged at 1440px hold at 390px.
 *
 * Export gives you the LAYOUT object to paste straight into lib/hero.ts.
 */

const SLOTS: Slot[] = ['word', 'splash', 'bottle', 'objects'];
const SEL: Record<Slot, string> = {
  word: '.vh-slide[data-on] .vh-word',
  splash: '.vh-slide[data-on] .vh-splash',
  bottle: '.vh-slide[data-on] .vh-bottle',
  objects: '.vh-slide[data-on] .vh-objects',
};
const FRAME_W: Record<BreakPoint, number | null> = { desktop: null, mobile: 390 };
const r1 = (n: number) => Math.round(n * 10) / 10;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export default function HeroLab() {
  const [bp, setBp] = useState<BreakPoint>('desktop');
  const [kind, setKind] = useState<MilkKind>('cow');
  const [slot, setSlot] = useState<Slot>('bottle');
  const [layout, setLayout] = useState(() => clone(LAYOUT));
  const [outline, setOutline] = useState(true);
  const frameRef = useRef<HTMLDivElement>(null);

  const cur = layout[bp][kind];

  /** write the edited layout onto the live slide, overriding the baked data */
  const apply = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const slide = frame.querySelector<HTMLElement>('.vh-slide[data-on]');
    if (!slide) return;
    const l = layout[bp][kind];
    slide.style.setProperty('--bottle-h', `${l.bottle.size}svh`);
    for (const s of ['bottle', 'splash', 'objects', 'word'] as Slot[]) {
      if (s !== 'bottle') slide.style.setProperty(`--${s}-w`, `${l[s].size}%`);
      slide.style.setProperty(`--${s}-x`, `${l[s].x}%`);
      slide.style.setProperty(`--${s}-y`, `${l[s].y}%`);
    }
  }, [layout, bp, kind]);

  useEffect(() => { apply(); });

  /* the hero switches variant itself; keep the editor's selection in step so you
     are never editing one variant while looking at the other */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const idx = VARIANTS.findIndex(v => v.kind === kind);
    const btns = frame.querySelectorAll<HTMLButtonElement>('.vh-switch button');
    btns[idx]?.click();
  }, [kind]);

  /* drag = position, wheel = size. Both measured against the live stage box, so
     what gets stored is a proportion and never a pixel. */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let active: Slot | null = null;
    let sx = 0, sy = 0, from: { x: number; y: number } | null = null;
    let box = { w: 1, h: 1 };

    const hit = (t: EventTarget | null): Slot | null => {
      if (!(t instanceof Element)) return null;
      for (const s of SLOTS) if (t.closest(SEL[s])) return s;
      return null;
    };
    const stageBox = () => {
      const el = frame.querySelector('.vh');
      const r = el?.getBoundingClientRect();
      return { w: r?.width || 1, h: r?.height || 1 };
    };

    const onDown = (e: PointerEvent) => {
      const s = hit(e.target);
      if (!s) return;
      active = s; setSlot(s);
      box = stageBox();
      sx = e.clientX; sy = e.clientY;
      from = { x: layout[bp][kind][s].x, y: layout[bp][kind][s].y };
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!active || !from) return;
      const dx = ((e.clientX - sx) / box.w) * 100;
      // y is positive UP (layers sit on a baseline), so drag down decreases it
      const dy = ((e.clientY - sy) / box.h) * 100;
      setLayout(L => {
        const n = clone(L);
        n[bp][kind][active!].x = r1(from!.x + dx);
        n[bp][kind][active!].y = r1(from!.y - dy);
        return n;
      });
    };
    const onUp = () => { active = null; from = null; };
    const onWheel = (e: WheelEvent) => {
      const s = hit(e.target);
      if (!s) return;
      e.preventDefault();
      setSlot(s);
      setLayout(L => {
        const n = clone(L);
        const step = e.deltaY > 0 ? -1.5 : 1.5;
        n[bp][kind][s].size = r1(Math.max(4, n[bp][kind][s].size + step));
        return n;
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
  }, [bp, kind, layout]);

  const set = (patch: Partial<{ x: number; y: number; size: number }>) =>
    setLayout(L => {
      const n = clone(L);
      Object.assign(n[bp][kind][slot], patch);
      return n;
    });

  const p = cur[slot];
  const unit = slot === 'bottle' ? 'svh' : '%';
  const out = exportLayout(layout);

  return (
    <div className="lab">
      <div className={`lab-stage${outline ? ' outline' : ''}`}>
        <div
          className="lab-frame"
          ref={frameRef}
          style={FRAME_W[bp] ? { width: FRAME_W[bp]!, margin: '0 auto' } : undefined}
        >
          <MilkHero />
        </div>
      </div>

      <aside className="lab-panel">
        <strong>Free canvas</strong>
        <p className="lab-hint">
          Drag any layer · wheel over it to resize · positions are a share of the stage
          (bottle in svh), never pixels, so a placement holds at every size.
        </p>

        <label>Breakpoint</label>
        <div className="lab-seg">
          {(['desktop', 'mobile'] as BreakPoint[]).map(b => (
            <button key={b} className={b === bp ? 'on' : undefined} onClick={() => setBp(b)}>
              {b}{FRAME_W[b] ? ` ${FRAME_W[b]}` : ''}
            </button>
          ))}
        </div>

        <label>Variant — each gets its own positions</label>
        <div className="lab-seg">
          {VARIANTS.map(v => (
            <button key={v.kind} className={v.kind === kind ? 'on' : undefined}
                    onClick={() => setKind(v.kind)}>
              {v.kind}
            </button>
          ))}
        </div>

        <label>Layer</label>
        <div className="lab-seg lab-seg-col">
          {SLOTS.map(s => (
            <button key={s} className={s === slot ? 'on' : undefined} onClick={() => setSlot(s)}>
              {s}
            </button>
          ))}
        </div>

        <label>x <span>{p.x}%</span></label>
        <input type="range" min={-90} max={90} step={0.5} value={p.x}
               onChange={e => set({ x: +e.target.value })} />
        <label>y <span>{p.y}%</span></label>
        <input type="range" min={-40} max={90} step={0.5} value={p.y}
               onChange={e => set({ y: +e.target.value })} />
        <label>{slot === 'bottle' ? 'height' : 'width'} <span>{p.size}{unit}</span></label>
        <input type="range" min={slot === 'bottle' ? 12 : 8}
               max={slot === 'bottle' ? 95 : 220} step={0.5} value={p.size}
               onChange={e => set({ size: +e.target.value })} />

        <label className="lab-check">
          <input type="checkbox" checked={outline} onChange={e => setOutline(e.target.checked)} />
          outline layers
        </label>

        <button className="lab-btn" onClick={() => setLayout(clone(LAYOUT))}>reset</button>
        <button className="lab-btn"
                onClick={() => { void navigator.clipboard?.writeText(out); }}>
          copy LAYOUT
        </button>

        <label>Paste into lib/hero.ts</label>
        <textarea className="lab-out" readOnly value={out} rows={20} />
      </aside>
    </div>
  );
}

/** Emits the LAYOUT object verbatim, ready to replace the one in lib/hero.ts. */
function exportLayout(L: Record<BreakPoint, Record<MilkKind, Layout>>): string {
  const one = (l: Layout, ind: string) =>
    (['bottle', 'splash', 'objects', 'word'] as Slot[])
      .map(s => `${ind}${s}: { x: ${l[s].x}, y: ${l[s].y}, size: ${l[s].size} },`)
      .join('\n');
  const variant = (k: MilkKind, bp: BreakPoint, ind: string) =>
    `${ind}${k}: {\n${one(L[bp][k], ind + '  ')}\n${ind}},`;
  const bpBlock = (bp: BreakPoint) =>
    `  ${bp}: {\n${variant('cow', bp, '    ')}\n${variant('buffalo', bp, '    ')}\n  },`;
  return `export const LAYOUT: Record<BreakPoint, Record<MilkKind, Layout>> = {\n${bpBlock('desktop')}\n${bpBlock('mobile')}\n};\n`;
}
