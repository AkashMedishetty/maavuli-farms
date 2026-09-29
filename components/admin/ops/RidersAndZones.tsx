'use client';

import { useState } from 'react';
import RidersPanel from '@/components/RidersPanel';
import ZoneMap from '@/components/ZoneMap';

/** Riders + zones on one screen; a zone saved on the map refreshes the rider list. */
export default function RidersAndZones({ canEdit }: { canEdit: boolean }) {
  const [key, setKey] = useState(0);
  return (
    <>
      <RidersPanel canEdit={canEdit} refreshKey={key} />
      <ZoneMap canEdit={canEdit} onChange={() => setKey(k => k + 1)} />
    </>
  );
}
