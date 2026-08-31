import { KOLAM } from '@/lib/generated/art';

/**
 * The kolam path is ~10 KB. Inlining it per instance (nav + CTA band + footer)
 * cost ~30 KB of pure duplication on a site whose entire premise is being light
 * on patchy 4G. So it is defined ONCE here and every instance <use>s it.
 *
 * Note the symbol's path carries no stroke-width: stroke-width is an inheritable
 * SVG presentation attribute, so each <Kolam> sets it on its own outer <svg> and
 * it reaches through <use> into the shadow tree. That keeps per-instance sizing
 * without per-instance geometry.
 */
export default function KolamDefs() {
  return (
    <svg aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <symbol id="kolam-mark" viewBox={KOLAM.viewBox.join(' ')}>
        <g fill="currentColor" data-pulli>
          {KOLAM.dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.r} />
          ))}
        </g>
        <path
          d={KOLAM.path}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </symbol>
    </svg>
  );
}
