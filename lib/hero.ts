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
/* Centred start for the STACKED mobile layout: the product now owns the upper 56%
   of the hero and the copy the lower 44%, so these are percentages of a portrait
   4:5 composition box, not of the whole screen. */
const MOBILE_COW: Layout = {
  bottle: { x: 0, y: 10, size: 66 },
  splash: { x: 0, y: 16, size: 100 },
  objects: { x: 0, y: 6, size: 86 },
  word: { x: 0, y: 46, size: 88 },
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
   * All of them, so buffalo is an exact reflection of cow — the client's call.
   * Worth knowing what it costs: every render is lit from the upper left, so
   * flipping the bottle puts its highlight and condensation on the upper right.
   * Because the splash and objects flip with it the light stays internally
   * consistent, but it is the opposite hand from the cow slide. Drop 'bottle' from
   * this list to keep the glassware lit the same way in both.
   */
  mirror: Exclude<Slot, 'word'>[];
  /**
   * Which side of the hero the words sit on.
   *
   * Buffalo is cow's mirror — its splash and objects are flipped and every layer
   * offset is negated — so the copy has to cross over with them. Left it where it
   * was, the words sat on top of the artwork instead of opposite it.
   */
  copySide: 'left' | 'right';
}

export const VARIANTS: readonly HeroVariant[] = [
  {
    kind: 'cow',
    name: 'Cow Milk',
    line: 'Lighter on the tongue, warm in the glass. At your door before the day starts.',
    field: '#8c170e',
    body: 'Light · warm white · easy daily',
    mirror: [],
    copySide: 'left',
  },
  {
    kind: 'buffalo',
    name: 'Buffalo Milk',
    line: 'Thick, and it stays thick. The one that sets curd overnight.',
    field: '#650f08',
    body: 'Dense · high fat · chalk white',
    mirror: ['splash', 'objects', 'bottle'],
    copySide: 'right',
  },
] as const;

export const assetPath = (slot: Exclude<Slot, 'word'>, kind: MilkKind) =>
  `/hero/${slot}-${kind}.png`;
