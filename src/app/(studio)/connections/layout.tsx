import type { ReactNode } from 'react';
import { SettingsFrame } from '@/components/studio/settings/settings-frame';

// 25.12: this section is part of Settings — the settings sub-navigation frames every page.
export default function SettingsSectionLayout({ children }: { children: ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
