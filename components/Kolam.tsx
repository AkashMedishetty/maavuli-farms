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
  crop = false,
  className,
  title,
}: {
  size?: number;
  strokeWidth?: number;
  dots?: boolean;
  /**
   * Show only the artwork's CENTRE MOTIF instead of the whole lattice.
   *
   * The kolam is a 5x5 pulli grid on a 40-unit pitch inside a 232.4-unit viewBox.
   * At 22px that pitch lands at 3.79 SCREEN PIXELS — narrower than the stroke drawn
   * over it — so the lattice cannot resolve at any weight and renders as a blob. No
   * stroke value fixes that; there is simply not enough room for five loops.
   *
   * So a small instance windows into the middle of the SAME vector instead. Nothing
   * is redrawn or approximated: the crop box is computed from the measured viewBox,
   * and three cells of the real grid at 28px give a 9.3px pitch, which reads.
   */
  crop?: boolean;
  className?: string;
  title?: string;
}) {
  const [vx, vy, vw, vh] = KOLAM.viewBox;
  const height = Math.round((size * vh) / vw);

  // three cells of the measured 40-unit pulli grid, centred on the artwork
  const CROP = 120;
  const cropBox = `${vx + vw / 2 - CROP / 2} ${vy + vh / 2 - CROP / 2} ${CROP} ${CROP}`;

  return (
    <svg
      width={size}
      height={crop ? size : height}
      /* Only the cropped variant gets a viewBox. The full mark must NOT have one:
         the symbol already establishes its own viewport, and duplicating it made the
         two coordinate systems compound and clipped the artwork. */
      viewBox={crop ? cropBox : undefined}
      strokeWidth={strokeWidth}
      className={`kolam${dots ? '' : ' no-pulli'}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {crop ? (
        // placed at the symbol's own origin and size, so the wrapper's viewBox
        // windows into it rather than rescaling it
        <use href="#kolam-mark" x={vx} y={vy} width={vw} height={vh} />
      ) : (
        <use href="#kolam-mark" width={size} height={height} />
      )}
    </svg>
  );
}
