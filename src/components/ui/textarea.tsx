import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldBase } from './field-styles';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldBase, 'flex field-sizing-content min-h-16 px-3 py-2', className)}
      {...props}
    />
  );
}

export { Textarea };
