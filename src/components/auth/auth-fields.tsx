'use client';

import { useId, useRef, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type AuthField, FieldError, fieldErrorProps } from './auth-card';

// 25.6 — a labelled auth text field: the label, the input (with the autocomplete the browser and
// password managers need), optional helper text, and the inline error linked by aria-describedby.

export function AuthTextField({
  label,
  hint,
  error,
  field,
  className,
  ...input
}: Omit<ComponentProps<'input'>, 'id'> & {
  label: string;
  hint?: string;
  /** The last submit's error; shown here when it belongs to `field`. */
  error?: unknown;
  field?: AuthField;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const ref = useRef<HTMLInputElement>(null);
  const errorProps = field ? fieldErrorProps(error, field, errorId) : {};
  const describedBy =
    [errorProps['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        ref={ref}
        id={id}
        {...input}
        aria-invalid={errorProps['aria-invalid']}
        aria-describedby={describedBy}
        className={className ?? 'h-10'}
      />
      {field && <FieldError id={errorId} error={error} field={field} inputRef={ref} />}
      {hint && (
        <p id={hintId} className="text-xs text-foreground-secondary">
          {hint}
        </p>
      )}
    </div>
  );
}
