import type { Metadata } from 'next';
import { ProjectsList } from '@/components/studio/projects/projects-list';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return <ProjectsList />;
}
