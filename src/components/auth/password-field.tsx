'use client';

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';

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
const BAR = ['bg-muted', 'bg-destructive', 'bg-warning', 'bg-primary', 'bg-success'];

export function PasswordField({
  value,
  onChange,
  autoComplete,
  label,
  showStrength = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  label: string;
  showStrength?: boolean;
}) {
  const t = useTranslations('auth.password');
  const id = useId();
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          minLength={autoComplete === 'new-password' ? PASSWORD_MIN : undefined}
          maxLength={PASSWORD_MAX}
          aria-describedby={showStrength ? hintId : undefined}
          className="h-10 pe-10"
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
          <p className="mt-1 text-xs text-muted-foreground">
            {t(`strength.${LEVELS[strength]}`)} · {t('rule', { min: PASSWORD_MIN })}
          </p>
        </div>
      )}
    </div>
  );
}
