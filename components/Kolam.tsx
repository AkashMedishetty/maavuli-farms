import { KOLAM } from '@/lib/generated/art';

/**
 * A kolam instance. Geometry lives once in <KolamDefs>; this only references it.
 *
 * The outer <svg> deliberately has NO viewBox. A <symbol> already establishes its
 * own viewport from its viewBox, so putting the same viewBox on the wrapper made
 * the two coordinate systems compound and clipped the mark. Sizing the <use>
 * instead lets the symbol map itself cleanly into it.
 *
 * Stroke weight is honest px because the symbol's path uses
 * vector-effect="non-scaling-stroke" — no scaling maths, no surprise hairlines.
 */
export default function Kolam({
  size = 280,
  strokeWidth = 3,
  dots = true,
  className,
  title,
}: {
  size?: number;
  strokeWidth?: number;
  dots?: boolean;
  className?: string;
  title?: string;
}) {
  const [, , vw, vh] = KOLAM.viewBox;
  const height = Math.round((size * vh) / vw);

  return (
    <svg
      width={size}
      height={height}
      strokeWidth={strokeWidth}
      className={`kolam${dots ? '' : ' no-pulli'}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <use href="#kolam-mark" width={size} height={height} />
    </svg>
  );
}
