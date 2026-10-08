import type { ManifestRun } from '@/lib/manifest';

/**
 * One line under a rider's run: their daily capacity and what load balancing did
 * at lock — doors borrowed from / handed to other riders for the day, and a warning
 * when they are still over capacity because nobody nearby had room.
 */
export function BalanceNote({ run }: { run: Pick<ManifestRun, 'capacity' | 'rebalance' | 'load'> }) {
  const cap = run.capacity;
  const reb = run.rebalance;
  if (!cap && !reb) return null;
  const capParts: string[] = [];
  if (cap?.maxStops !== undefined) capParts.push(`${run.load.stops}/${cap.maxStops} stops`);
  if (cap?.maxLitres !== undefined) capParts.push(`${run.load.cowLitres + run.load.buffaloLitres}/${cap.maxLitres} L`);
  return (
    <p className="ops-muted" style={{ margin: '0.2rem 0' }}>
      {capParts.length > 0 && <>Capacity {capParts.join(' · ')}</>}
      {reb && reb.movedIn > 0 && <>{capParts.length ? ' · ' : ''}borrowed {reb.movedIn} from other riders</>}
      {reb && reb.movedOut > 0 && <>{capParts.length || reb.movedIn ? ' · ' : ''}handed {reb.movedOut} to others</>}
      {reb?.overCapacity && (
        <>
          {' '}
          <span className="ops-badge is-warn">over capacity — no rider nearby had room</span>
        </>
      )}
    </p>
  );
}
