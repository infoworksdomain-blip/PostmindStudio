import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PublicationsCalendar } from '@/components/studio/calendar/publications-calendar';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('calendar');
  return { title: t('title') };
}

export default function CalendarPage() {
  return <PublicationsCalendar />;
}
