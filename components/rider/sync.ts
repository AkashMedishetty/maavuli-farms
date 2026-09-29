'use client';

import {
  allQueued,
  backoffMs,
  removeQueued,
  updateQueued,
  type QueuedAction,
} from './queue';

/* -------------------------------------------------------- image compression -- */

/**
 * Compress a camera File to a JPEG whose longest side is ≤ maxPx, quality ~0.7.
 * Runs on the phone before upload — a raw 12 MP photo is ~4 MB, this lands ~150 KB,
 * which is what keeps a morning of deliveries inside a rider's data and inside the
 * 2 MB upload cap.
 */
export async function compressImage(file: File, maxPx = 1280, quality = 0.7): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext('2d');
  if (!cx) throw new Error('canvas unsupported');
  cx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('image encode failed');
  return blob;
}

/** Best-effort GPS. Never rejects — a fix we don't have must not block a delivery. */
export function getPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number; accuracyM?: number } | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 },
    );
  });
}

/* ------------------------------------------------------------------ API ---- */

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
}

export async function apiStartRun(): Promise<void> {
  const res = await postJson('/api/rider/actions', { op: 'start_run' });
  if (!res.ok) throw new Error(`start_run failed (${res.status})`);
}

export async function apiCloseRun(returns: Record<string, unknown>): Promise<void> {
  const res = await postJson('/api/rider/actions', { op: 'close_run', returns });
  if (!res.ok) throw new Error(`close_run failed (${res.status})`);
}

/**
 * Upload one photo blob for a delivery and return its storage key.
 * local driver: POST raw bytes. blob driver: fetch a client token then upload().
 */
export async function uploadPhoto(deliveryId: string, blob: Blob, contentType = 'image/jpeg'): Promise<string> {
  // Ask the server where to put it (and, on blob, for a token).
  const tokenRes = await postJson('/api/rider/photos', { deliveryId, contentType });
  if (tokenRes.headers.get('content-type')?.includes('application/json')) {
    const data = (await tokenRes.json()) as { driver?: string; key?: string; token?: string; error?: string };
    if (!tokenRes.ok || !data.key) throw new Error(data.error ?? `photo init failed (${tokenRes.status})`);

    if (data.driver === 'vercel-blob' && data.token) {
      const { put } = await import('@vercel/blob/client');
      await put(data.key, blob, { access: 'private', token: data.token, contentType });
      return data.key;
    }
    // Local driver was probed with JSON; resend as raw bytes to the same endpoint.
  }

  const raw = await fetch(`/api/rider/photos?deliveryId=${encodeURIComponent(deliveryId)}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: blob,
    cache: 'no-store',
  });
  const data = (await raw.json()) as { key?: string; error?: string };
  if (!raw.ok || !data.key) throw new Error(data.error ?? `photo upload failed (${raw.status})`);
  return data.key;
}

/* --------------------------------------------------------------- flush loop -- */

export interface FlushResult {
  flushed: number;
  remaining: number;
}

/**
 * Drain the offline queue: for each due action, upload its photo (if any and not yet
 * uploaded), then POST the action. On success remove it; on failure bump attempts
 * and schedule the next try with backoff. Server idempotency makes this safe to run
 * repeatedly and concurrently with a fresh capture.
 */
export async function flushQueue(): Promise<FlushResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const all = await allQueued();
    return { flushed: 0, remaining: all.length };
  }

  const now = Date.now();
  const queued = await allQueued();
  let flushed = 0;

  for (const a of queued) {
    if (a.nextAttemptAt > now) continue;
    try {
      let photoKey = a.photoKey;
      if (!photoKey && a.photoBlob) {
        photoKey = await uploadPhoto(a.deliveryId, a.photoBlob, a.photoContentType ?? 'image/jpeg');
        await updateQueued({ ...a, photoKey });
      }

      const action = {
        actionId: a.actionId,
        type: a.type,
        deliveryId: a.deliveryId,
        ...(a.note ? { note: a.note } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
        ...(photoKey ? { proof: { ...a.proof, photoKey } } : a.proof ? { proof: a.proof } : {}),
      };

      const res = await postJson('/api/rider/actions', { op: 'actions', actions: [action] });
      if (!res.ok) throw new Error(`actions failed (${res.status})`);
      const data = (await res.json()) as { results?: { ok: boolean; error?: string; retryable?: boolean }[] };
      const r = data.results?.[0];
      if (r && !r.ok && r.retryable !== true) {
        // A permanent rejection (e.g. illegal transition, not this rider's stop) —
        // drop it so it does not wedge the queue forever, but keep going. The server
        // marks transient failures `retryable`, and those stay queued with backoff.
        await removeQueued(a.actionId);
        continue;
      }
      if (!r?.ok) throw new Error(r?.error ?? 'action rejected');

      await removeQueued(a.actionId);
      flushed++;
    } catch {
      const attempts = a.attempts + 1;
      await updateQueued({ ...a, attempts, nextAttemptAt: Date.now() + backoffMs(attempts) });
    }
  }

  const remaining = (await allQueued()).length;
  return { flushed, remaining };
}

function isRetryable(error?: string): boolean {
  if (!error) return true;
  // Network-ish / conflict errors are worth retrying; validation/ownership are not.
  return !/not your delivery|invalid|required|Unknown reason|action type/i.test(error);
}
