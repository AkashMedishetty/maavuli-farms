import type { MilkKind } from './pricing';

/**
 * Hero variant config, MILKI-style: one saturated field per milk, giant wordmark
 * behind, bottle centre, crown splash around it, objects suspended in front.
 *
 * The renders are in. Masters live in assets/brand/hero-src/ at full size; what
 * ships in public/hero/ is downscaled to display size, and next/image serves AVIF
 * or WebP per breakpoint from there. Raw PNG is never sent to a browser — 4.8 MB
 * of PNG on patchy 4G would defeat the reason this is a PWA.
 */
export const ASSETS_READY = true;

export type Slot = 'bottle' | 'splash' | 'objects';

/** True pixel dimensions, so next/image reserves the right box and CLS stays 0. */
export const SLOT_SIZE: Record<Slot, Record<MilkKind, { w: number; h: number }>> = {
  bottle: {
    cow: { w: 1100, h: 1100 },
    buffalo: { w: 1100, h: 1100 },
  },
  splash: {
    cow: { w: 1400, h: 933 },
    buffalo: { w: 1400, h: 788 },
  },
  objects: {
    cow: { w: 1400, h: 933 },
    buffalo: { w: 1400, h: 933 },
  },
};

export interface HeroVariant {
  kind: MilkKind;
  name: string;
  line: string;
  field: string;
  /** how the milk itself differs — the honest differentiator, not a flavour */
  body: string;
}

export const VARIANTS: readonly HeroVariant[] = [
  {
    kind: 'cow',
    name: 'Cow Milk',
    line: 'Lighter on the tongue, warm in the glass. At your door before the day starts.',
    field: '#8c170e',
    body: 'Light · warm white · easy daily',
  },
  {
    kind: 'buffalo',
    name: 'Buffalo Milk',
    line: 'Thick, and it stays thick. The one that sets curd overnight.',
    field: '#650f08',
    body: 'Dense · high fat · chalk white',
  },
] as const;

export const assetPath = (slot: Slot, kind: MilkKind) => `/hero/${slot}-${kind}.png`;
