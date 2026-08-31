/**
 * Parametric Warli.
 *
 * Warli's entire grammar is a circle, two triangles meeting apex-to-apex, and
 * straight lines. That means figures can be COMPOSED from parameters rather than
 * traced from stock art: one consistent line weight everywhere, ~1 KB per scene,
 * every limb individually animatable, and unlimited poses without sourcing a
 * single new asset.
 *
 * Returns plain path strings: `f` are filled shapes (the rice-paste bodies),
 * `s` are stroked lines (limbs, horns, branches).
 */

export interface Glyph {
  f: string[];
  s: string[];
  w: number;
  h: number;
}

const R = (d: number) => (d * Math.PI) / 180;
const n = (v: number) => Math.round(v * 10) / 10;
const line = (pts: [number, number][]) =>
  `M${pts.map(p => `${n(p[0])},${n(p[1])}`).join('L')}`;
const tri = (pts: [number, number][]) => line(pts) + 'Z';

/** 0deg is straight down; positive swings outward. `side` mirrors for the left limb. */
const step = (x: number, y: number, len: number, deg: number, side: number): [number, number] => [
  x + side * len * Math.sin(R(deg)),
  y + len * Math.cos(R(deg)),
];

export interface Pose {
  hr?: number;
  sw?: number;
  armL?: number;
  armR?: number;
  bendL?: number;
  bendR?: number;
  legL?: number;
  legR?: number;
}

export function figure(o: Pose = {}): Glyph {
  const hr = o.hr ?? 10;
  const sw = o.sw ?? 15;
  const { armL = 30, armR = 30, bendL = 25, bendR = 25, legL = 12, legR = 14 } = o;
  const shoulderY = 2 * hr + 9;
  const waistY = shoulderY + 24;
  const hipY = waistY + 24;

  const f = [
    `M${-hr},${hr}a${hr},${hr} 0 1,0 ${hr * 2},0a${hr},${hr} 0 1,0 ${-hr * 2},0Z`,
    tri([[-sw, shoulderY], [sw, shoulderY], [0, waistY]]),
    tri([[0, waistY], [-sw, hipY], [sw, hipY]]),
  ];

  const arm = (side: number, a: number, b: number) => {
    const sx = side * (sw - 1);
    const sy = shoulderY + 2;
    const el = step(sx, sy, 15, a, side);
    const hd = step(el[0], el[1], 14, a + b, side);
    return line([[sx, sy], el, hd]);
  };
  const leg = (side: number, a: number) => {
    const hx = side * (sw - 5);
    const kn = step(hx, hipY, 15, a, side);
    const an = step(kn[0], kn[1], 15, a * 0.6, side);
    return line([[hx, hipY], kn, an, [an[0] + side * 7, an[1] + 1]]);
  };

  return {
    f,
    s: [line([[0, hr * 2], [0, shoulderY]]), arm(-1, armL, bendL), arm(1, armR, bendR), leg(-1, -legL), leg(1, legR)],
    w: sw * 2 + 34,
    h: hipY + 34,
  };
}

/** Hourglass body, horned head, four straight legs. Faces right. */
export function cow(): Glyph {
  return {
    f: [
      tri([[8, 10], [8, 42], [46, 26]]),
      tri([[46, 26], [80, 10], [80, 42]]),
      tri([[80, 20], [80, 34], [100, 27]]),
    ],
    s: [
      line([[86, 18], [92, 4]]), line([[92, 4], [89, 2]]),
      line([[92, 18], [98, 5]]), line([[98, 5], [101, 4]]),
      line([[16, 40], [14, 66]]), line([[34, 42], [33, 66]]),
      line([[62, 42], [63, 66]]), line([[76, 40], [79, 66]]),
      line([[8, 18], [-8, 10]]), line([[-8, 10], [-12, 18]]),
    ],
    w: 116,
    h: 70,
  };
}

export function tree(): Glyph {
  const s = [line([[0, 110], [0, 26]])];
  for (const [y, len] of [[74, 26], [58, 24], [42, 20], [30, 14]] as const) {
    for (const side of [-1, 1]) {
      const t = step(0, y, len, 58, side);
      s.push(line([[0, y], t]));
      s.push(line([t, step(t[0], t[1], 9, 30, side)]));
      s.push(line([t, step(t[0], t[1], 9, 86, side)]));
    }
  }
  return { f: [], s, w: 60, h: 112 };
}

export function sun(rays = 12, r = 11): Glyph {
  const s: string[] = [];
  for (let i = 0; i < rays; i++) {
    const a = R((i * 360) / rays);
    const c = Math.cos(a);
    const si = Math.sin(a);
    s.push(line([[c * (r + 4), si * (r + 4)], [c * (r + 12), si * (r + 12)]]));
  }
  return { f: [`M${-r},0a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0Z`], s, w: (r + 12) * 2, h: (r + 12) * 2 };
}

/** Wavy bands — Warli's water and tilled soil. */
export function ground(w = 260, bands = 2, step_ = 26): Glyph {
  const s: string[] = [];
  for (let b = 0; b < bands; b++) {
    let d = `M0,${b * 12}`;
    for (let x = 0; x < w; x += step_) d += `q${step_ / 2},-9 ${step_},0`;
    s.push(d);
  }
  return { f: [], s, w, h: bands * 12 + 12 };
}

/**
 * The tarpa dance — a spiral of figures holding hands round the musician. It is
 * THE iconic Warli composition and it already means community, so "you are part
 * of the Maavuli family" needs no further illustrating.
 */
export function tarpa(count = 9, radius = 96): Glyph {
  const f: string[] = [];
  const s: string[] = [];
  const hands: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = R((i * 360) / count - 90);
    const cx = Math.cos(a) * radius;
    const cy = Math.sin(a) * radius * 0.52 - 40;
    const g = figure({ hr: 7, sw: 10, armL: 78, armR: 78, bendL: 8, bendR: 8, legL: 16, legR: 18 });
    const tf = `translate(${n(cx)},${n(cy)})`;
    g.f.forEach(d => f.push(`${tf}|${d}`));
    g.s.forEach(d => s.push(`${tf}|${d}`));
    hands.push([cx, cy + 18]);
  }
  for (let i = 0; i < count; i++) {
    const a = hands[i]!;
    const b = hands[(i + 1) % count]!;
    s.push(`|${line([[a[0] + 14, a[1]], [b[0] - 14, b[1]]])}`);
  }
  return { f, s, w: radius * 2 + 60, h: radius + 140 };
}

/**
 * Glyph -> SVG markup. Entries may carry a `transform|d` prefix (tarpa does), so
 * each part can be placed without the caller re-deriving any geometry.
 */
export function render(g: Glyph, strokeWidth = 4, cls = ''): string {
  const part = (d: string, kind: 'f' | 's') => {
    const [maybeTf, path] = d.includes('|') ? d.split('|') : [null, d];
    const tf = maybeTf ? ` transform="${maybeTf}"` : '';
    return kind === 'f'
      ? `<path class="wf ${cls}" d="${path}"${tf}/>`
      : `<path class="ws ${cls}" d="${path}" stroke-width="${strokeWidth}"${tf}/>`;
  };
  return g.f.map(d => part(d, 'f')).join('') + g.s.map(d => part(d, 's')).join('');
}
