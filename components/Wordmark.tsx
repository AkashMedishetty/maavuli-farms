import { WORDMARK } from '@/lib/generated/art';
import { BRAND } from '@/lib/content';

/**
 * The real wordmark, as outlines lifted from the client's vector logo PDF.
 *
 * This is why it matters: the MILKI reference puts a giant wordmark behind the
 * bottle, and at that size an approximated typeface is obvious. Outlines are also
 * ~20 KB of vector that stays crisp at any size — no webfont request, no FOUT, no
 * licensing question about the display face.
 *
 * Falls back to type if the PDF was never converted, so the build never breaks on
 * a missing asset.
 */
export default function Wordmark({
  className,
  title,
}: {
  className?: string;
  title?: string;
}) {
  if (!WORDMARK) {
    return (
      <span className={className} aria-label={title}>
        {BRAND.name}
      </span>
    );
  }

  return (
    <svg
      viewBox={WORDMARK.viewBox.join(' ')}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="currentColor">
        {WORDMARK.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
