/**
 * Pricing is DERIVED, never stored as a table.
 *
 * The client supplied a 16-row price matrix that contained seven arithmetic
 * errors — all in the cow tables — because the cells were typed by hand:
 *   · cow 1yr ORIGINAL read 40,500 where 115 x 360 = 41,400
 *   · cow 1yr SAVE read 5,130, which is the *buffalo* saving, copy-pasted
 *   · cow 3mo FINAL read 9,817.50 where 10,350 x 0.95 = 9,832.50 (a 5.145% cut)
 *   · and the halved equivalents of each in the 0.5 L tables
 *
 * Every one of those is impossible here: there is one formula and one source of
 * truth. The base rates below are the client's own, taken from the 1-month rows,
 * which reconcile exactly (2,850 / 30 = 95 and 3,450 / 30 = 115).
 *
 * Money is handled in PAISE as integers. Multiplications happen before any
 * division so intermediate values stay whole — no float drift on money.
 */

export type MilkKind = 'buffalo' | 'cow';

export interface Tenure {
  /** stable id used in URLs and in Mongo */
  id: string;
  label: string;
  days: number;
  /** whole-percent discount; 0 for the entry tenure */
  discountPct: number;
}

/** Litres per day, as an exact fraction so 0.5 L never becomes 0.49999 */
export interface Quantity {
  id: string;
  label: string;
  num: number;
  den: number;
}

export interface MilkProduct {
  kind: MilkKind;
  label: string;
  /** client-supplied rate per litre per day, in paise */
  baseRatePaise: number;
  /**
   * Breed/grade claim. NULL means we have not confirmed it and the site must not
   * assert one — cow at a higher rate than buffalo inverts the usual fat logic,
   * which is normal for A2/desi but is a claim, not a guess.
   */
  breedClaim: string | null;
}

export const TENURES: readonly Tenure[] = [
  { id: '1m', label: '1 Month',  days: 30,  discountPct: 0  },
  { id: '3m', label: '3 Months', days: 90,  discountPct: 5  },
  { id: '6m', label: '6 Months', days: 180, discountPct: 10 },
  { id: '1y', label: '1 Year',   days: 360, discountPct: 15 },
] as const;

/**
 * Pause days included with a plan of `days` delivery days. One source for the
 * subscription engine (stored on each plan when it starts) and the policy pages.
 */
export function pauseDaysFor(days: number): number {
  if (days <= 30) return 3;
  if (days <= 90) return 20;
  if (days <= 180) return 25;
  return 30;
}

/** "1 Month: 3 days, 3 Months: 20 days, …" — the policy pages' statement of pauseDaysFor. */
export function pauseDaysSummary(): string {
  return TENURES.map(t => `${t.label}: ${pauseDaysFor(t.days)} days`).join(', ');
}

export const QUANTITIES: readonly Quantity[] = [
  { id: 'half', label: '½ Litre / day', num: 1, den: 2 },
  { id: 'one',  label: '1 Litre / day', num: 1, den: 1 },
] as const;

export const PRODUCTS: readonly MilkProduct[] = [
  { kind: 'buffalo', label: 'Buffalo Milk', baseRatePaise: 9500,  breedClaim: null },
  { kind: 'cow',     label: 'Cow Milk',     baseRatePaise: 11500, breedClaim: null },
] as const;

export interface Quote {
  kind: MilkKind;
  tenureId: string;
  quantityId: string;
  days: number;
  /** total litres across the whole tenure */
  litres: number;
  /** undiscounted total, paise */
  originalPaise: number;
  /** what the customer pays, paise */
  finalPaise: number;
  /** originalPaise - finalPaise */
  savingPaise: number;
  discountPct: number;
  /** effective rate per litre, paise — the number customers actually compare */
  perLitrePaise: number;
}

function findOrThrow<T>(xs: readonly T[], pred: (x: T) => boolean, what: string): T {
  const hit = xs.find(pred);
  if (!hit) throw new Error(`unknown ${what}`);
  return hit;
}

/**
 * The single pricing calculation. Integer-only, multiply-before-divide.
 * Throws rather than guessing when an id is unknown — a silently wrong price is
 * worse than a crash on a money surface.
 */
export function quote(kind: MilkKind, quantityId: string, tenureId: string): Quote {
  const product = findOrThrow(PRODUCTS, p => p.kind === kind, `milk kind "${kind}"`);
  const qty     = findOrThrow(QUANTITIES, q => q.id === quantityId, `quantity "${quantityId}"`);
  const tenure  = findOrThrow(TENURES, t => t.id === tenureId, `tenure "${tenureId}"`);

  // paise x days x numerator  -> then divide. Keeps every intermediate whole.
  const grossNumer = product.baseRatePaise * tenure.days * qty.num;
  if (grossNumer % qty.den !== 0) {
    throw new Error(`indivisible gross for ${kind}/${quantityId}/${tenureId}`);
  }
  const originalPaise = grossNumer / qty.den;

  const netNumer = originalPaise * (100 - tenure.discountPct);
  if (netNumer % 100 !== 0) {
    throw new Error(`indivisible discount for ${kind}/${quantityId}/${tenureId}`);
  }
  const finalPaise = netNumer / 100;

  const litresNumer = tenure.days * qty.num;
  const litres = litresNumer / qty.den;
  const perLitreNumer = finalPaise * qty.den;
  const perLitrePaise = perLitreNumer / litresNumer;

  return {
    kind,
    tenureId,
    quantityId,
    days: tenure.days,
    litres,
    originalPaise,
    finalPaise,
    savingPaise: originalPaise - finalPaise,
    discountPct: tenure.discountPct,
    perLitrePaise,
  };
}

/** Every quote for one milk kind — what the plan chooser renders from. */
export function quotesFor(kind: MilkKind): Quote[] {
  return QUANTITIES.flatMap(q => TENURES.map(t => quote(kind, q.id, t.id)));
}

/**
 * Indian-format currency. Paise are only shown when they are non-zero, because
 * "₹8,122.50" is right but "₹2,850.00" reads like a spreadsheet.
 */
export function formatINR(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rem = paise % 100;
  const grouped = rupees.toLocaleString('en-IN');
  return rem === 0 ? `₹${grouped}` : `₹${grouped}.${String(rem).padStart(2, '0')}`;
}
