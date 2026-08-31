'use client';

import { useEffect, useRef } from 'react';
import { KOLAM } from '@/lib/generated/art';

/**
 * A kolam being drawn, at something like the speed one is actually drawn.
 *
 * The order is not decorative. A kolam starts as a grid of pulli — dots — and the
 * line is then looped around them, so the dots land first and the strokes follow.
 * Fading the whole mark in at once would get the sequence backwards.
 *
 * The extracted artwork is ONE path string holding 49 subpaths. Splitting it on
 * the M commands gives each stroke its own element, which is what lets them draw
 * in sequence: a single path with one dashoffset animates every subpath
 * simultaneously and reads as a fade, not as drawing. `pathLength="1"` normalises
 * each stroke so the dash arithmetic is unit-free — no getTotalLength(), nothing
 * to recompute on resize.
 *
 * It draws when scrolled into view rather than on mount, because the whole point
 * is being watched.
 */

/** Split a compound path into its subpaths, keeping each move command. */
function subpaths(d: string): string[] {
  return d
    .split(/(?=[Mm])/)
    .map(s => s.trim())
    .filter(Boolean);
}

const STROKES = subpaths(KOLAM.path);

interface Props {
  className?: string;
  /** how long one stroke takes to draw */
  strokeMs?: number;
  /** gap between consecutive strokes — this is the dial for overall pace */
  stagger?: number;
  strokeWidth?: number;
}

export default function KolamDraw({
  className,
  strokeMs = 620,
  stagger = 95,
  strokeWidth = 2.2,
}: Props) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Motion is the feature here, so with reduced motion we show the finished
    // kolam rather than an empty box.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('kd-on');
      return;
    }

    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('kd-on');
            io.disconnect();
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const [x, y, w, h] = KOLAM.viewBox;

  return (
    <svg
      ref={ref}
      className={['kd', className].filter(Boolean).join(' ')}
      viewBox={`${x} ${y} ${w} ${h}`}
      style={{
        ['--kd-stroke' as string]: `${strokeMs}ms`,
        ['--kd-step' as string]: `${stagger}ms`,
      }}
      aria-hidden="true"
    >
      {KOLAM.dots.map((d, i) => (
        <circle
          key={`d${i}`}
          className="kd-dot"
          cx={d.x}
          cy={d.y}
          r={d.r}
          style={{ ['--i' as string]: i }}
        />
      ))}
      {STROKES.map((d, i) => (
        <path
          key={`s${i}`}
          className="kd-line"
          d={d}
          pathLength={1}
          strokeWidth={strokeWidth}
          style={{ ['--i' as string]: i }}
        />
      ))}
    </svg>
  );
}
