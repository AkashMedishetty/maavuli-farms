import Link from 'next/link';
import { Footer } from '@/components/Sections';
import Kolam from '@/components/Kolam';
import { PILLARS, BRAND, CONTACT } from '@/lib/content';
import { WARLI } from '@/lib/generated/art';
import { cow, tree, ground, figure, render } from '@/lib/warli';
import NavPanel from '@/components/NavPanel';

export const metadata = { title: 'Our Farm' };

const HEADER_SCENE = [
  `<g transform="translate(70,120) scale(1.1)">${render(tree(), 3)}</g>`,
  `<g transform="translate(300,196)">${render(cow(), 3.2)}</g>`,
  `<g transform="translate(540,214) scale(.86)">${render(cow(), 3.6)}</g>`,
  `<g transform="translate(240,178) scale(.92)">${render(figure({ armL: 96, bendL: 52, armR: 88, bendR: 58, legL: 30, legR: 4 }), 3.4)}</g>`,
  `<g transform="translate(0,286)">${render(ground(820, 3, 30), 3)}</g>`,
].join('');

export default function OurFarmPage() {
  return (
    <>
      <NavPanel />
      <main className="page">
        <header className="page-head">
          <p className="eyebrow">Our farm</p>
          <h1>{BRAND.premise}</h1>
          <p>
            Maavuli is a working dairy, not a distribution brand. The milk you get in the
            morning was in the animal the same morning — it does not travel to a plant, get
            standardised, and come back.
          </p>
        </header>

        <svg className="farm-band" viewBox="0 0 820 330" aria-hidden="true">
          <g dangerouslySetInnerHTML={{ __html: HEADER_SCENE }} />
        </svg>

        <section className="farm-pillars">
          {PILLARS.map((p, i) => {
            const art = WARLI[p.art];
            return (
              <article key={p.id}>
                <div>
                  <p className="eyebrow">{String(i + 1).padStart(2, '0')}</p>
                  <h2>{p.title}</h2>
                  <p>{p.body}</p>
                </div>
                <svg className="wart is-static" viewBox={art.viewBox.join(' ')} aria-hidden="true">
                  <path className="wart-ink" d={art.path} />
                </svg>
              </article>
            );
          })}
        </section>

        <section className="farm-close">
          <Kolam size={140} strokeWidth={2.2} />
          <h2>Come and look.</h2>
          <p>
            The farm is at {CONTACT.address}. If you want to see the animals and the shed
            before you subscribe, that is the most reasonable question anyone asks us.
          </p>
          <div className="farm-close-actions">
            <Link className="cta" href="/subscribe">Start a subscription</Link>
            <Link className="cta" href="/contact">Arrange a visit</Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
