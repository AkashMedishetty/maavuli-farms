import type { MilkKind } from './pricing';

/**
 * Hero variant config, MILKI-style: one saturated field per milk, giant wordmark
 * behind, bottle centre, crown splash around it, objects suspended in front.
 *
 * `ASSETS_READY` is the single switch. While it is false the hero draws SVG
 * stand-ins that hold the exact layout, so nothing shifts when the real renders
 * land in public/hero/ — see assets/brand/HERO-ASSET-BRIEF.md.
 */
export const ASSETS_READY = false;

export interface HeroVariant {
  kind: MilkKind;
  /** shown as the slide's name */
  name: string;
  /** one line, in the voice of the product */
  line: string;
  /** the field colour for this slide */
  field: string;
  /** how the milk itself differs — this is the honest differentiator, not a flavour */
  body: string;
}

export const VARIANTS: readonly HeroVariant[] = [
  {
    kind: 'buffalo',
    name: 'Buffalo Milk',
    line: 'Thick, and it stays thick. The one that makes curd set overnight.',
    field: '#650f08',
    body: 'Dense, high-fat, chalk white',
  },
  {
    kind: 'cow',
    name: 'Cow Milk',
    line: 'Lighter on the tongue, warm in the glass. Every morning, before the gate opens.',
    field: '#8c170e',
    body: 'Light, warm white, easy daily',
  },
] as const;

/** File naming the brief specifies, so renders drop straight in. */
export const assetPath = (slot: 'bottle' | 'splash' | 'objects', kind: MilkKind) =>
  `/hero/${slot}-${kind}.png`;
