import { canOperate, pageStaff } from '@/lib/admin';
import RidersAndZones from '@/components/admin/ops/RidersAndZones';

export const dynamic = 'force-dynamic';

/** Riders & zones. Data loads client-side from /api/admin/riders and /api/admin/zones. */
export default async function AdminRidersPage() {
  const p = await pageStaff();
  if (!p) return null;
  const canEdit = canOperate(p.staffRole);
  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Riders &amp; zones</p>
        <h1>Who delivers where</h1>
        <p className="ops-sub">
          Changes apply from the next day that locks; a day already locked keeps its runs (use a cover rider on Today or
          Tomorrow instead).
          {!canEdit && ' You have read-only access.'}
        </p>
      </header>
      <RidersAndZones canEdit={canEdit} />
    </>
  );
}
