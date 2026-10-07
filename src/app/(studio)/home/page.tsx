import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HomeScreen } from '@/components/studio/home/home-screen';

// BACKLOG 25.4 — the signed-in home: what needs you, what is coming up, what is being made.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('home');
  return { title: t('title') };
}

export default function HomePage() {
  return <HomeScreen />;
}
