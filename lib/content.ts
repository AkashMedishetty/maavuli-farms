/**
 * All client-supplied content lives here.
 *
 * Two copy corrections were applied, both flagged to the client:
 *  · "with no zero-adulteration" -> "with zero adulteration". The original is a
 *    double negative that asserts the OPPOSITE of what is meant, on the purity
 *    claim of a trust-led product.
 *  · "adultrations" -> "adulterants".
 *
 * Anything not yet supplied is `null` or empty and MUST render as an explicit
 * "announced soon" state. Nothing on this site invents a fact — a fabricated
 * FSSAI number or an assumed delivery area is worse than a blank one.
 */

export const BRAND = {
  name: 'Maavuli',
  fullName: 'Maavuli Farm Milk',
  domain: 'maavulifarmmilk.com',
  tagline: 'Drawn every morning.',
  /**
   * A kolam goes on the doorstep at dawn, by hand, every day. The milk arrives at
   * dawn, on the same doorstep, every day. Same ritual, same place, same hour —
   * which is why the kolam is the brand's thread and not just its ornament.
   */
  premise:
    'A kolam is drawn at the doorstep before the household wakes. So is our delivery.',
} as const;

export const CONTACT = {
  address: 'BN 447, Balram Nagar, Safilguda, Hyderabad, Telangana',
  email: 'info@maavulifarmmilk.com',
  phones: ['+91 70752 02177'],
  /** Legally required on a dairy site. NOT SUPPLIED — renders as pending. */
  fssaiLicence: null as string | null,
  instagram: null as string | null,
  invite: "Have questions or feedback? We'd love to hear from you.",
  inviteCta: "Hey, let's talk!",
} as const;

/**
 * Serviceability is authoritative by PINCODE, never by reverse-geocoded district.
 * Empty list = we cannot claim to deliver anywhere yet, and the checker must say
 * so rather than defaulting to "yes".
 */
export const SERVICEABLE_PINCODES: readonly string[] = [];

export interface Pillar {
  id: string;
  title: string;
  body: string;
  /**
   * Which traced Warli carries it. This is the CLIENT's own mapping:
   * warli-1 doorstep · warli-2 customers · warli-3 pure · warli-4 cows · warli-5 farmers
   */
  art: 'farmers' | 'cows' | 'pure' | 'doorstep' | 'customers';
}

export const PILLARS: readonly Pillar[] = [
  {
    id: 'farmers',
    title: 'Trained farmers',
    body:
      'The farmers at Maavuli Farm are well-trained in both traditional and modern dairy practices.',
    art: 'farmers',
  },
  {
    id: 'cows',
    title: 'Healthy and happy cows',
    body:
      'We believe healthy animals give healthy milk. That is why we feed our cows and buffaloes a ' +
      'balanced mix of green grass, dry fodder, silage, grains and natural supplements, with zero ' +
      'adulteration. This diet keeps them strong, happy and full of energy.',
    art: 'cows',
  },
  {
    id: 'pure',
    title: 'Free from antibiotics and adulterants',
    body:
      'We avoid any harmful chemicals or artificial boosters — just clean, wholesome milk straight ' +
      'from nature. Because when our animals are cared for with love, it shows in every drop of milk.',
    art: 'pure',
  },
  {
    id: 'doorstep',
    title: 'Delivered at your doorstep',
    body:
      'At Maavuli, we deliver pure, fresh milk directly from our farm to your doorstep every ' +
      'morning. Milk is collected, packed in clean bottles and delivered within hours — no ' +
      'processing, no middlemen, just natural goodness in every drop.',
    art: 'doorstep',
  },
  {
    id: 'customers',
    title: 'We value our customers',
    body:
      'At Maavuli, our customers are at the heart of everything we do. We go the extra mile to ' +
      'ensure you receive pure, fresh and safe milk every single day. Your health and trust matter ' +
      'most to us — we never compromise on quality, hygiene or honesty. For us, you are part of ' +
      'the Maavuli family.',
    art: 'customers',
  },
] as const;

/** Still to be confirmed by the client — each blocks a real surface. */
export const PENDING = [
  'FSSAI licence number (legally required to display)',
  'Serviceable pincode list',
  'Whether the cow milk is A2 / desi breed',
  'Delivery window and daily order cutoff',
  'Pause / skip and refund policy (Razorpay needs the latter to activate)',
] as const;
