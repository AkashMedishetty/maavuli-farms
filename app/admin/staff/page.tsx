import '../crm.css';
import { loadErrorMessage, pageStaff } from '@/lib/admin';
import { listStaff, type StaffRow } from '@/lib/admin-customers';
import { LoadError } from '@/components/admin/ops/server';
import { dateTimeLabel } from '@/components/admin/ops/format';
import { telHref } from '@/components/admin/crm/labels';
import { AddStaff, StaffControls } from '@/components/admin/crm/StaffForms';

export const dynamic = 'force-dynamic';

const ROLE = { owner: 'Owner', ops: 'Ops', support: 'Support' } as const;

export default async function AdminStaffPage() {
  const p = await pageStaff();
  if (!p) return null;
  if (p.staffRole !== 'owner') {
    return (
      <header className="ops-head">
        <p className="ops-eyebrow">Staff</p>
        <h1>Owner only</h1>
        <p className="ops-sub">Only an owner can see and manage the staff list.</p>
      </header>
    );
  }

  let rows: StaffRow[] | null = null;
  let error: string | null = null;
  try {
    rows = await listStaff();
  } catch (err) {
    error = loadErrorMessage(err);
  }

  return (
    <>
      <header className="ops-head">
        <p className="ops-eyebrow">Staff</p>
        <h1>Who can use the admin</h1>
        <p className="ops-sub">Access follows the role on every request — a change applies immediately.</p>
      </header>

      {error || !rows ? (
        <LoadError what="the staff list" message={error ?? 'Unknown error.'} />
      ) : (
        <section className="ops-card" aria-label="Staff">
          {rows.length === 0 ? (
            <p className="ops-empty">No staff yet.</p>
          ) : (
            <ul className="ops-list">
              {rows.map(s => {
                const self = s.mobile === p.mobile;
                return (
                  <li key={s.mobile}>
                    <div className="ops-card-head">
                      <h3>
                        {s.name}
                        {self ? ' (you)' : ''}
                      </h3>
                      <span className={`ops-badge ${s.active ? 'is-ok' : ''}`}>
                        {ROLE[s.role]}
                        {s.active ? '' : ' · inactive'}
                      </span>
                    </div>
                    <p className="crm-row-meta" style={{ margin: '0.2rem 0' }}>
                      <a href={telHref(s.mobile)}>{s.mobile}</a>
                      {s.updatedAt ? ` · changed ${dateTimeLabel(s.updatedAt)}` : ''}
                    </p>
                    {s.envOwner ? (
                      <p className="ops-muted">Owner from the server configuration (ADMIN_MOBILES) — fixed, cannot be changed here.</p>
                    ) : self ? (
                      <p className="ops-muted">You cannot change your own role or deactivate yourself — ask another owner.</p>
                    ) : (
                      <StaffControls mobile={s.mobile} role={s.role} active={s.active} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="ops-card" aria-label="Add staff">
        <h2>Add a staff member</h2>
        <AddStaff />
      </section>
    </>
  );
}
