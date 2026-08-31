import { WORDMARK } from '@/lib/generated/art';
import { BRAND } from '@/lib/content';

/**
 * The real wordmark, as outlines lifted from the client's vector logo PDF.
 *
 * `line` picks what to draw:
 *   'both'  the full lockup, Maavuli over Farm Milk
 *   'name'  just "Maavuli" — what the hero wants, because a two-line lockup
 *           cannot be positioned like a single word
 *   'sub'   just "Farm Milk"
 *
 * Every viewBox is tightened to the actual glyphs. That matters more than it
 * sounds: the untightened line1 box was 587 units wide for 446 units of letters,
 * so ~24% of any requested width was invisible padding and nothing could be
 * placed predictably.
 *
 * Falls back to type if the PDF was never converted, so a missing asset cannot
 * break the build.
 */
export default function Wordmark({
  line = 'both',
  className,
  title,
}: {
  line?: 'both' | 'name' | 'sub';
  className?: string;
  title?: string;
}) {
  const src =
    !WORDMARK ? null
    : line === 'name' ? WORDMARK.line1
    : line === 'sub' ? WORDMARK.line2
    : WORDMARK;

  if (!src) {
    return (
      <span className={className} aria-label={title}>
        {line === 'sub' ? 'Farm Milk' : BRAND.name}
      </span>
    );
  }

  return (
    <svg
      viewBox={src.viewBox.join(' ')}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="currentColor">
        {src.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
