/**
 * The farm photography.
 *
 * The site was built photo-free on purpose — type and parametric Warli — and that
 * still carries most of it. But real animals and a real family holding the sign are
 * the one thing an illustration cannot claim on a trust-led product, so photography
 * comes in as a second, deliberate layer: a feature on the farm panel, a small
 * gallery, and the family on the closing call to action.
 *
 * Every entry carries its true pixel box so next/image reserves space and CLS stays
 * 0. Sources live in public/farm, re-encoded from the originals (EXIF-oriented,
 * capped at ~2000px, mozjpeg q82) by scripts, never served raw.
 */
export interface Photo {
  src: string;
  w: number;
  h: number;
  alt: string;
}

export const FARM = {
  family: {
    src: '/farm/family-sign.jpg',
    w: 1334,
    h: 2000,
    alt: 'The Maavuli family in the field at sunset, holding the Maavuli Farm Milk sign',
  },
  cowCalf: {
    src: '/farm/cow-calf.jpg',
    w: 1600,
    h: 1066,
    alt: 'A Gir cow and her calf standing together at the edge of the fodder field',
  },
  cowCalfTall: {
    src: '/farm/cow-calf-portrait.jpg',
    w: 1066,
    h: 1600,
    alt: 'A Gir cow with her calf, the calf facing the camera',
  },
  calfGraze: {
    src: '/farm/calf-graze.jpg',
    w: 1800,
    h: 1200,
    alt: 'A Gir calf seen low through the grass',
  },
  cow: {
    src: '/farm/cow-portrait.jpg',
    w: 1066,
    h: 1600,
    alt: 'A Gir cow standing in front of tall green fodder',
  },
  cowSquare: {
    src: '/farm/cow-square.jpg',
    w: 1600,
    h: 1600,
    alt: 'A Gir cow in the field',
  },
  land: {
    src: '/farm/farm-land.jpg',
    w: 1600,
    h: 1043,
    alt: 'The Maavuli farm — the cattle shed, coconut palms and the green fodder field',
  },
} satisfies Record<string, Photo>;
