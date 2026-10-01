import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { ProjectsList } from '@/components/studio/projects/projects-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('projects.list');
  return { title: t('title') };
}

export default function ProjectsPage() {
  // The list reads ?filter= and ?q= from the URL (useSearchParams).
  return (
    <Suspense>
      <ProjectsList />
    </Suspense>
  );
}
