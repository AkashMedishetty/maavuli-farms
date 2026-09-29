/**
 * Where to send someone after sign-in. Only a same-origin RELATIVE path is
 * accepted: it must start with a single '/', never '//' or '/\' (both are
 * protocol-relative to a browser), no backslashes or control characters anywhere,
 * and not back to /account itself. Anything else → null (stay on /account).
 */
export function safeNext(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > 200) return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null;
  if (/^\/account(\/|\?|#|$)/.test(v)) return null;
  return v;
}
