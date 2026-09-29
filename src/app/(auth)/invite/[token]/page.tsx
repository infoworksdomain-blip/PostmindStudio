import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InviteScreen } from '@/components/auth/invite-screen';
import { currentUserId } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.invite');
  return { title: t('title') };
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteScreen invitationId={token} signedIn={(await currentUserId()) !== null} />;
}
