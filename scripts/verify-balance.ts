/**
 * Assertions for lib/balance.ts — who delivers which door when a rider is over
 * capacity or a zone has no rider. A wrong move sends a rider across the city or
 * overloads the receiver, so each guarantee is checked.
 *
 *   pnpm test:balance
 */
import { planBalance, type BalanceRider, type BalanceStop } from '../lib/balance';

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: boolean) => (cond ? pass++ : fails.push(label));

// Two riders ~1.1 km apart on the same latitude (0.01° lng ≈ 1.06 km near 17.4°N).
const A = { lat: 17.4, lng: 78.4 };
const B = { lat: 17.4, lng: 78.41 };
const FAR = { lat: 17.4, lng: 78.6 }; // ~21 km east
const stop = (k: string, lng: number, litres = 1, pinned = true): BalanceStop => ({
  stopKey: k,
  litres,
  ...(pinned ? { location: { lat: 17.4, lng } } : {}),
});
const rider = (key: string, anchor: { lat: number; lng: number }, extra: Partial<BalanceRider> = {}): BalanceRider => ({
  key,
  riderId: key,
  active: true,
  anchor,
  ...extra,
});
const groups = (o: Record<string, BalanceStop[]>) => new Map(Object.entries(o));
const riders = (...rs: BalanceRider[]) => new Map(rs.map(r => [r.key, r]));

/* ---- no capacity anywhere, nothing unassigned → nothing moves ---- */
{
  const r = planBalance(groups({ a: [stop('a1', 78.4), stop('a2', 78.401)], b: [stop('b1', 78.41)] }), riders(rider('a', A), rider('b', B)));
  ok('no limits: no moves', r.moves.length === 0 && r.overCapacity.length === 0);
}

/* ---- over capacity: sheds the doors nearest the neighbour, until within capacity ---- */
{
  // a holds 4 doors spread toward b; cap 2 → the two doors nearest b go to b
  const r = planBalance(
    groups({ a: [stop('a1', 78.4), stop('a2', 78.402), stop('a3', 78.406), stop('a4', 78.408)], b: [stop('b1', 78.41)] }),
    riders(rider('a', A, { maxStops: 2 }), rider('b', B)),
  );
  const moved = r.moves.map(m => m.stopKey).sort().join(',');
  ok('over capacity: exactly 2 doors move', r.moves.length === 2);
  ok('over capacity: the doors nearest b move (a3, a4)', moved === 'a3,a4');
  ok('over capacity: they go to b', r.moves.every(m => m.to === 'b' && m.reason === 'over_capacity'));
  ok('over capacity: a is no longer reported overloaded', r.overCapacity.length === 0);
}

/* ---- the receiver's own capacity is respected ---- */
{
  const r = planBalance(
    groups({ a: [stop('a1', 78.4), stop('a2', 78.402), stop('a3', 78.406)], b: [stop('b1', 78.41)] }),
    riders(rider('a', A, { maxStops: 1 }), rider('b', B, { maxStops: 2 })),
  );
  ok('receiver cap: b takes only one', r.moves.length === 1 && r.moves[0]!.to === 'b');
  ok('receiver cap: a still reported over capacity', r.overCapacity.includes('a'));
}

/* ---- no handoff beyond the distance limit ---- */
{
  const r = planBalance(
    groups({ a: [stop('a1', 78.4), stop('a2', 78.401)], far: [stop('f1', 78.6)] }),
    riders(rider('a', A, { maxStops: 1 }), rider('far', FAR)),
  );
  ok('distance limit: nothing sent 20 km away', r.moves.length === 0);
  ok('distance limit: a reported over capacity', r.overCapacity.includes('a'));
}

/* ---- litres capacity ---- */
{
  const r = planBalance(
    groups({ a: [stop('a1', 78.4, 2), stop('a2', 78.408, 2)], b: [stop('b1', 78.41, 1)] }),
    riders(rider('a', A, { maxLitres: 2 }), rider('b', B)),
  );
  ok('litres cap: one 2 L door moves to b', r.moves.length === 1 && r.moves[0]!.stopKey === 'a2' && r.moves[0]!.to === 'b');
}

/* ---- load already frozen in the run counts toward capacity ---- */
{
  const r = planBalance(
    groups({ a: [stop('a1', 78.4), stop('a2', 78.409)], b: [stop('b1', 78.41)] }),
    riders(rider('a', A, { maxStops: 5, fixedStops: 4 }), rider('b', B)),
  );
  ok('fixed load: 4 locked + 2 new over a cap of 5 → one moves', r.moves.length === 1 && r.moves[0]!.stopKey === 'a2');
}

/* ---- unassigned doors go to the nearest rider with room ---- */
{
  const unassigned: BalanceRider = { key: 'unassigned', riderId: null, active: false };
  const r = planBalance(
    groups({ unassigned: [stop('u1', 78.409), stop('u2', 78.6, 1)], a: [stop('a1', 78.4)], b: [stop('b1', 78.41)] }),
    riders(rider('a', A), rider('b', B), unassigned),
  );
  ok('unassigned: u1 goes to the nearer rider (b)', r.moves.some(m => m.stopKey === 'u1' && m.to === 'b' && m.reason === 'unassigned'));
  ok('unassigned: u2, 20 km out, stays unassigned', r.stillUnassigned.includes('u2'));
}

/* ---- a door with no pin never moves; an inactive rider never receives ---- */
{
  const r = planBalance(
    groups({ a: [stop('a1', 78.4, 1, false), stop('a2', 78.4, 1, false)], b: [] }),
    riders(rider('a', A, { maxStops: 1 }), rider('b', B)),
  );
  ok('pinless: not moved', r.moves.length === 0);
  const r2 = planBalance(
    groups({ a: [stop('a1', 78.4), stop('a2', 78.409)], b: [stop('b1', 78.41)] }),
    riders(rider('a', A, { maxStops: 1 }), rider('b', B, { active: false })),
  );
  ok('inactive receiver: gets nothing', r2.moves.length === 0);
}

/* ---- deterministic and does not mutate its input ---- */
{
  const g = groups({ a: [stop('a1', 78.4), stop('a2', 78.402), stop('a3', 78.406)], b: [stop('b1', 78.41)] });
  const rs = riders(rider('a', A, { maxStops: 1 }), rider('b', B));
  const x = JSON.stringify(planBalance(g, rs));
  const y = JSON.stringify(planBalance(g, rs));
  ok('deterministic', x === y);
  ok('input untouched', g.get('a')!.length === 3 && g.get('b')!.length === 1);
}

console.log(`\nbalance: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
