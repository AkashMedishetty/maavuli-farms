'use client';

import { useState } from 'react';
import Link from 'next/link';
import Wordmark from './Wordmark';
import { VARIANTS, ASSETS_READY, assetPath } from '@/lib/hero';
import { quote, formatINR } from '@/lib/pricing';

/**
 * MILKI-style hero: saturated field per variant, giant wordmark behind, bottle
 * centre-front, crown splash around it, objects suspended in front, switcher
 * bottom-right.
 *
 * Until the renders land, each slot draws an SVG stand-in occupying the EXACT box
 * the real asset will occupy — so approving the layout now means nothing shifts
 * later. The stand-ins are deliberately obviously placeholders; a fake-looking
 * photoreal bottle would be worse than an honest outline.
 *
 * "Flavour" is the wrong frame for unflavoured milk, so the two slides differ on
 * what actually differs: body, fat and use. No invented fruit.
 */
export default function MilkHero() {
  const [i, setI] = useState(0);
  const v = VARIANTS[i]!;
  const perLitre = quote(v.kind, 'one', '1y').perLitrePaise;

  return (
    <header className="mhero" style={{ ['--field' as string]: v.field }}>
      <div className="mhero-field" />

      <Wordmark className="mhero-word" />

      <div className="mhero-stage">
        {ASSETS_READY ? (
          <>
            <img className="mh-splash" src={assetPath('splash', v.kind)} alt="" aria-hidden />
            <img className="mh-bottle" src={assetPath('bottle', v.kind)} alt={`${v.name} bottle`} />
            <img className="mh-objects" src={assetPath('objects', v.kind)} alt="" aria-hidden />
          </>
        ) : (
          <Placeholders />
        )}
      </div>

      <div className="mhero-copy">
        <p className="eyebrow">{v.body}</p>
        <h1>{v.name}</h1>
        <p className="mhero-line">{v.line}</p>
        <p className="mhero-price">
          from <strong>{formatINR(perLitre)}</strong> a litre
        </p>
        <Link className="cta" href={`/subscribe?milk=${v.kind}`}>
          Subscribe to {v.name.split(' ')[0]}
        </Link>
      </div>

      <div className="mhero-switch" role="tablist" aria-label="Choose your milk">
        {VARIANTS.map((x, n) => (
          <button
            key={x.kind}
            role="tab"
            aria-selected={n === i}
            className={n === i ? 'on' : undefined}
            style={{ ['--dot' as string]: x.field }}
            onClick={() => setI(n)}
          >
            <span aria-hidden />
            {x.name.split(' ')[0]}
          </button>
        ))}
      </div>

      {!ASSETS_READY && (
        <p className="mhero-flag">
          Layout is final · bottle, splash and floating objects are stand-ins until the
          renders land in <code>public/hero/</code>
        </p>
      )}
    </header>
  );
}

/**
 * Stand-ins at the real assets' exact boxes. Line art on purpose: a half-convincing
 * photoreal bottle invites approval of something that will not look like this.
 */
function Placeholders() {
  return (
    <svg className="mh-ph" viewBox="0 0 900 760" aria-label="Placeholder product composition" role="img">
      {/* splash: the crown ring the render will fill */}
      <g className="ph-splash" fill="none" strokeWidth="2" strokeDasharray="7 9">
        <ellipse cx="450" cy="470" rx="360" ry="120" />
        <path d="M110 460q80-150 180-120M790 460q-80-150-180-120M240 400q40-120 130-150M660 400q-40-120-130-150" />
        <circle cx="150" cy="250" r="13" /><circle cx="760" cy="286" r="17" />
        <circle cx="286" cy="170" r="10" /><circle cx="612" cy="146" r="12" />
      </g>

      {/* bottle: the silhouette from the brief — tall glass, shoulder, cap, label panel */}
      <g className="ph-bottle" strokeWidth="2.5" fill="none">
        <path d="M392 150h116v58l30 66v370a26 26 0 0 1-26 26H388a26 26 0 0 1-26-26V274l30-66Z" />
        <rect x="388" y="120" width="124" height="36" rx="7" />
        <rect x="392" y="330" width="116" height="150" rx="5" strokeDasharray="6 7" />
        <text x="450" y="415" textAnchor="middle" className="ph-label">label</text>
      </g>

      {/* objects: vessel + fodder, suspended */}
      <g className="ph-objects" strokeWidth="2" fill="none" strokeDasharray="7 9">
        <path d="M120 620q40-50 96-30l-14 54q-52 6-82-24Z" />
        <path d="M742 596q-46-44-98-18l18 52q54 2 80-34Z" />
        <path d="M196 700q40-44 92-30M660 690q-40-40-92-26" />
      </g>
    </svg>
  );
}
