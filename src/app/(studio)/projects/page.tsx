import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProjectsList } from '@/components/studio/projects/projects-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('projects.list');
  return { title: t('title') };
}

export default function ProjectsPage() {
  return <ProjectsList />;
}
