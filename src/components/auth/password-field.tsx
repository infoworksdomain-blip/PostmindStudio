'use client';

import { useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { authErrorField, FieldError } from './auth-card';

// Phase 18 §5.1: passwords are 12–128 characters. The meter is guidance only; the server rejects
// short and breached passwords (HIBP) whatever the meter says.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type Strength = 0 | 1 | 2 | 3 | 4;

/** 0 = too short, 1 weak, 2 fair, 3 good, 4 strong. Length matters most; variety adds a little. */
export function passwordStrength(password: string): Strength {
  if (password.length < PASSWORD_MIN) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const repeated = /(.)\1{3,}/.test(password);
  let score = password.length >= 20 ? 3 : password.length >= 16 ? 2 : 1;
  if (classes >= 3) score += 1;
  if (repeated) score -= 1;
  return Math.max(1, Math.min(4, score)) as Strength;
}

const LEVELS = ['tooShort', 'weak', 'fair', 'good', 'strong'] as const;
// 25.6: the signal colour is kept for primary actions; the meter climbs from error to success.
const BAR = ['bg-muted', 'bg-destructive', 'bg-warning', 'bg-success/60', 'bg-success'];

export function PasswordField({
  value,
  onChange,
  autoComplete,
  label,
  showStrength = false,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  label: string;
  showStrength?: boolean;
  /** The last submit's error: shown under the field when it is about the password. */
  error?: unknown;
}) {
  const t = useTranslations('auth.password');
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);
  const invalid = authErrorField(error) === 'password';
  const describedBy =
    [invalid ? errorId : null, showStrength ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          minLength={autoComplete === 'new-password' ? PASSWORD_MIN : undefined}
          maxLength={PASSWORD_MAX}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className="h-10 pe-11"
        />
        <IconButton
          type="button"
          label={visible ? t('hide') : t('show')}
          tooltip={false}
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 end-1 my-auto"
        >
          {visible ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
      <FieldError id={errorId} error={error} field="password" inputRef={inputRef} />
      {showStrength && (
        <div id={hintId} aria-live="polite">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  i <= strength ? BAR[strength] : 'bg-muted',
                )}
              />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-foreground-secondary">
            {t(`strength.${LEVELS[strength]}`)} · {t('rule', { min: PASSWORD_MIN })}
          </p>
        </div>
      )}
    </div>
  );
}
