import Image from 'next/image';
import { FARM, type Photo } from '@/lib/photos';

/**
 * A short photographic interlude on the white field, between the farm promise and
 * the five pillars. The warm greens and browns of the animals carry against white,
 * and it answers the one question a dairy customer actually has — is this a real
 * farm — before the page asks them to subscribe.
 *
 * Art-directed on a fixed grid: one wide establishing shot, one tall portrait
 * running the full height beside it, and three squarer frames beneath. Every image
 * fills its cell (object-fit: cover), so the layout holds and the crop does the
 * composing. On a narrow screen the grid collapses to a single stacked column.
 */
const TILES: { area: string; photo: Photo; sizes: string }[] = [
  // wide establishing shot — the shed, the palms, the fodder field
  { area: 'land', photo: FARM.land, sizes: '(max-width: 820px) 92vw, 66vw' },
  // single cow, portrait, runs the full height of the right column
  { area: 'tall', photo: FARM.cow, sizes: '(max-width: 820px) 92vw, 22vw' },
  { area: 'a', photo: FARM.calfGraze, sizes: '(max-width: 820px) 92vw, 22vw' },
  { area: 'b', photo: FARM.cowCalf, sizes: '(max-width: 820px) 92vw, 22vw' },
  { area: 'c', photo: FARM.cowSquare, sizes: '(max-width: 820px) 92vw, 22vw' },
];

export default function FarmGallery() {
  return (
    <section className="section farm-gallery" id="the-farm">
      <div className="wrap">
        <div className="farm-gallery-head">
          <p className="eyebrow">On the farm</p>
          <h2>Come and see where it comes from.</h2>
          <p>
            Our Gir cows and their calves, and the shed they walk back to each evening —
            photographed on the farm, not bought from a library.
          </p>
        </div>

        <div className="farm-gallery-grid">
          {TILES.map(t => (
            <figure key={t.area} className={`fg-item fg-${t.area}`}>
              <Image
                src={t.photo.src}
                alt={t.photo.alt}
                width={t.photo.w}
                height={t.photo.h}
                sizes={t.sizes}
              />
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
