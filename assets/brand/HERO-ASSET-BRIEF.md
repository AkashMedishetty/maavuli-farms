# Hero asset brief — cow & buffalo, MILKI-style

Reference: `large-thumbnail20260826-3877040-35enve.mp4` (the "MILKI" milkshake concept).
Structure to reproduce: saturated field per variant · giant wordmark behind ·
product bottle centre-front · milk crown erupting around it · elements suspended
mid-air · variant switcher bottom-right.

**Read this first.** Two things about the reference that are decisions, not details:

1. **It is a photoreal 3D product aesthetic.** The rest of this site is Warli and
   kolam line art. Those are different visual languages and mixing them carelessly
   reads as two brands stapled together. It *does* work if the hero borrows its
   typography and colour from our system and the line art carries provenance
   further down the page — but the hero must not also contain Warli. Pick one
   register per section.
2. **The reference's floating objects are fruit.** Plain milk has no strawberry.
   Substituting fruit would be dishonest for an unflavoured product. Our
   equivalent is *provenance*: traditional vessels, fresh fodder, and milk itself.

---

## Brand constants — do not let the renderer drift off these

| | |
|---|---|
| Brand red | `#8C170E` (sampled from the vector logo — **not** #8E1B1B) |
| Milk white | `#FFFFFF` |
| Cow field | `#8C170E` |
| Buffalo field | `#650F08` (deeper oxblood — same family, so slides don't look like different brands) |
| Bottle label type | Set later in the real typeface. **Render labels blank or with placeholder marks.** |

**Critical:** do not ask the model to write "Maavuli" on the bottle. Generative
type is always subtly wrong and it is a logo. Render the bottle with a **blank
white label panel**; the wordmark gets composited in as real vector, which we now
have from `assets/brand/logo-vector.svg`.

---

## Asset list — 6 renders total

Each **PNG with real alpha transparency**, no baked background, no drop shadow on
a solid plate.

### 1 & 2 — The bottle (one per variant)

> Product photograph of a single tall glass milk bottle filled with fresh whole
> milk, sealed with a matte deep-red aluminium cap. Clean blank white rectangular
> label panel on the front, no text, no logo. Three-quarter front view, slight
> upward camera angle, eye level just below the shoulder of the bottle. Studio
> lighting: one large soft key from upper left, subtle rim light from behind right
> to separate the glass edge. Condensation beads on the upper third of the glass.
> Milk is opaque and bright, not translucent. Sharp focus throughout, high detail
> on glass refraction at the base. Isolated on a fully transparent background.
> Square composition, centred, generous margin. Photorealistic commercial product
> render, 8k.

Variant differences — keep the *bottle* identical, change the milk:

- **Cow:** `milk is bright warm white, slightly yellow-cream cast, lighter body`
- **Buffalo:** `milk is dense chalk white, noticeably thicker and creamier, opaque with a faint blue-cool cast at the highlights`

### 3 & 4 — The milk crown / splash (one per variant)

> A dramatic crown-shaped splash of thick fresh milk frozen mid-air, erupting
> outward and upward in a radial ring with long trailing ribbons and separated
> droplets of varying size. Viewed from slightly below the rim of the crown.
> Liquid is opaque, glossy, high surface tension, smooth ribbons rather than foam.
> No container, no bottle, no surface, no table. Backlit rim light picking out the
> edges of every ribbon. Isolated on a fully transparent background. Wide
> horizontal composition. Photorealistic high-speed liquid photography, 8k.

- **Cow:** lighter, faster, thinner ribbons, more separated droplets
- **Buffalo:** heavier, slower, thicker ribbons, fewer and larger droplets

### 5 & 6 — Suspended provenance objects

This is where we depart from the reference, on purpose.

> A small group of objects floating and suspended in mid-air against a fully
> transparent background, arranged loosely as if frozen in flight, each casting no
> shadow. Photorealistic, studio lit with a soft key from upper left, sharp focus.

- **Cow set:** `a traditional Indian brass tumbler on its side with milk arcing out of it, three or four fresh green fodder blades, two loose milk droplets`
- **Buffalo set:** `a hammered copper milk vessel tipped mid-pour, a short sheaf of jowar millet with grain heads, two thick milk droplets`

---

## Direction notes for whoever renders these

- **Alpha, not white.** A white background on a white product is unusable — the
  edges cannot be keyed out. If the tool cannot do real alpha, render on
  **mid-grey `#808080`** and say so; that keys cleanly. Never render on red.
- **One light direction across all six.** Key from upper left in every asset. Mixed
  key directions is the single fastest way to make a composite look fake.
- **No shadows contacting a surface.** These float. A cast shadow implies a table
  that does not exist in the layout.
- **No text anywhere**, including on vessels and labels.
- **Square or 3:2, minimum 2048px** on the long edge. We will downscale; we cannot
  upscale.
- Deliver as **PNG with alpha**. I will convert to AVIF + WebP with fallbacks.

## Payload budget — this is a real constraint

Six photoreal transparent PNGs is potentially 3–6 MB, on a mobile-first PWA aimed
at district Telangana on patchy 4G. That is the opposite of why we chose a PWA.
How it will be handled:

- AVIF primary, WebP fallback, PNG never shipped
- the **second variant lazy-loads** on switch, not on first paint
- the giant wordmark stays **vector** (from the logo PDF), never rasterised
- target: **under 350 KB for the first-paint variant**

If a render lands above ~600 KB after AVIF, the splash is the asset to simplify —
fewer droplets compresses dramatically better than fewer ribbons.

## Naming — drop them in `public/hero/` exactly like this

```
bottle-cow.png      splash-cow.png      objects-cow.png
bottle-buffalo.png  splash-buffalo.png  objects-buffalo.png
```

## Still open

- Does the bottle shape need to match your **actual** bottles? If you have a photo
  of the real packaging, that beats any prompt here.
- Is buffalo the second slide or the first? Buffalo is cheaper (₹95/L vs ₹115/L),
  so it is arguably the better opener commercially.
