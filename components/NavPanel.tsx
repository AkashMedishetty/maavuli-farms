import Nav from './Nav';

/**
 * The nav lives inside the red panel. On the homepage that panel is the hero; on
 * every other page there is no hero, so this is the panel — a short red band that
 * carries the nav and the protruding brand tab.
 *
 * Without it those pages would render the nav's white pills on a white page and
 * disappear.
 */
export default function NavPanel() {
  return (
    <div className="panel navpanel">
      <Nav />
    </div>
  );
}
