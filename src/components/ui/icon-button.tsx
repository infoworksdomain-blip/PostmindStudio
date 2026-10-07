'use client';

import * as React from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// BACKLOG 25.3 — an icon-only button always has a name: `label` becomes its aria-label and a
// tooltip (shown on hover and keyboard focus), replacing the old `title=` attributes that
// touch and keyboard users never saw. Ghost by default — icon buttons live in toolbars and rows.

type IconButtonProps = Omit<ButtonProps, 'size' | 'aria-label' | 'title'> & {
  /** What the button does, e.g. "Delete brand kit". Required. */
  label: string;
  size?: 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
  /** Where the tooltip sits; `false` hides the tooltip (the name stays). */
  tooltip?: 'top' | 'bottom' | 'left' | 'right' | false;
};

function IconButton({
  label,
  size = 'icon-sm',
  variant = 'ghost',
  tooltip = 'top',
  children,
  ...props
}: IconButtonProps) {
  const button = (
    <Button aria-label={label} size={size} variant={variant} {...props}>
      {children}
    </Button>
  );
  if (tooltip === false) return button;
  // A local provider so the button also works outside the app's providers (tests, the demo).
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltip}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { IconButton, type IconButtonProps };
