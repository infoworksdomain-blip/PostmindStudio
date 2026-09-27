import type { Metadata } from 'next';
import { PublicationsCalendar } from '@/components/studio/calendar/publications-calendar';

export const metadata: Metadata = { title: 'Calendar' };

export default function CalendarPage() {
  return <PublicationsCalendar />;
}
