import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ImageStudioScreen } from '@/components/studio/images/image-studio-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('images.page');
  return { title: t('title') };
}

// BACKLOG 25.8 — Image Studio: generate images for the business from a prompt.
export default function ImagesPage() {
  return <ImageStudioScreen />;
}
