'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Submit button for a Server Action form: while the action runs it disables itself
 * and shows `pendingLabel`, so a slow connection cannot turn one tap into several
 * submissions (each "Send code" tap would mint a new sign-in code).
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export default SubmitButton;
