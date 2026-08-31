import type { MilkKind } from './pricing';

/**
 * Hero config.
 *
 * Positions are DATA, one set per breakpoint x variant x layer. Units are a
 * percentage of the STAGE for x/y, svh for the bottle's size and a percentage of
 * stage width for the other sizes. Nothing is a pixel, which is what makes a
 * placement hold at every viewport.
 *
 * Arrange by dragging at /hero-lab and paste the exported block back here.
 */
export const ASSETS_READY = true;

export type Slot = 'bottle' | 'splash' | 'objects' | 'word';
export type BreakPoint = 'desktop' | 'mobile';

export interface Placement {
  x: number;
  y: number;
  size: number;
}

export type Layout = Record<Slot, Placement>;

/** True pixel dimensions, so next/image reserves the right box and CLS stays 0. */
export const SLOT_SIZE: Record<Exclude<Slot, 'word'>, Record<MilkKind, { w: number; h: number }>> = {
  bottle: { cow: { w: 1100, h: 1100 }, buffalo: { w: 1100, h: 1100 } },
  splash: { cow: { w: 1400, h: 933 }, buffalo: { w: 1400, h: 788 } },
  objects: { cow: { w: 1400, h: 933 }, buffalo: { w: 1400, h: 933 } },
};

/**
 * Buffalo is the mirror of cow: every x negated. Deriving it rather than storing a
 * second set means the two can never drift apart — re-drag cow and buffalo follows.
 * (A consequence: editing buffalo directly in the lab is discarded on the next
 * paste. Change `mirrorLayout` to a literal if you ever want them independent.)
 */
function mirrorLayout(l: Layout): Layout {
  const flip = (p: Placement): Placement => ({ ...p, x: -p.x });
  return { bottle: flip(l.bottle), splash: flip(l.splash), objects: flip(l.objects), word: flip(l.word) };
}

/** Arranged on the free canvas. */
const DESKTOP_COW: Layout = {
  bottle: { x: 19, y: -4.5, size: 58 },
  splash: { x: 18, y: -2, size: 50.5 },
  objects: { x: -12.5, y: 6, size: 34 },
  word: { x: -31.5, y: 64, size: 35 },
};

/* Centred starting point. The previous mobile numbers were recorded while the y
   sign was inconsistent between layers, so they are not salvageable — re-drag. */
const MOBILE_COW: Layout = {
  bottle: { x: 0, y: 4, size: 44 },
  splash: { x: 0, y: 10, size: 104 },
  objects: { x: 0, y: 2, size: 88 },
  word: { x: 0, y: 58, size: 120 },
};

export const LAYOUT: Record<BreakPoint, Record<MilkKind, Layout>> = {
  desktop: { cow: DESKTOP_COW, buffalo: mirrorLayout(DESKTOP_COW) },
  // mirrored on mobile too: a no-op while the composition is centred, and correct
  // the moment it is not
  mobile: { cow: MOBILE_COW, buffalo: mirrorLayout(MOBILE_COW) },
};

/** CSS custom properties for one variant's layout. Applied inline by the hero. */
export function layoutVars(l: Layout): Record<string, string> {
  return {
    '--bottle-h': `${l.bottle.size}%`,
    '--bottle-x': `${l.bottle.x}%`,
    '--bottle-y': `${l.bottle.y}%`,
    '--splash-w': `${l.splash.size}%`,
    '--splash-x': `${l.splash.x}%`,
    '--splash-y': `${l.splash.y}%`,
    '--objects-w': `${l.objects.size}%`,
    '--objects-x': `${l.objects.x}%`,
    '--objects-y': `${l.objects.y}%`,
    '--word-w': `${l.word.size}%`,
    '--word-x': `${l.word.x}%`,
    '--word-y': `${l.word.y}%`,
  };
}

export interface HeroVariant {
  kind: MilkKind;
  name: string;
  line: string;
  field: string;
  body: string;
  /**
   * Which layers to flip horizontally.
   *
   * Deliberately NOT the bottle. Every render was lit from the upper left, and
   * mirroring the bottle flips its highlight and condensation to the upper right —
   * which reads as a second light source sitting next to an unmirrored splash. The
   * splash and the floating objects have no such tell, so they mirror cleanly and
   * carry the whole sense of the composition having turned around.
   */
  mirror: Exclude<Slot, 'word'>[];
}

export const VARIANTS: readonly HeroVariant[] = [
  {
    kind: 'cow',
    name: 'Cow Milk',
    line: 'Lighter on the tongue, warm in the glass. At your door before the day starts.',
    field: '#8c170e',
    body: 'Light · warm white · easy daily',
    mirror: [],
  },
  {
    kind: 'buffalo',
    name: 'Buffalo Milk',
    line: 'Thick, and it stays thick. The one that sets curd overnight.',
    field: '#650f08',
    body: 'Dense · high fat · chalk white',
    mirror: ['splash', 'objects'],
  },
] as const;

export const assetPath = (slot: Exclude<Slot, 'word'>, kind: MilkKind) =>
  `/hero/${slot}-${kind}.png`;
