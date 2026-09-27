import type { Metadata } from 'next';
import { parseReference } from '@/components/studio/create/body';
import { CreateScreen } from '@/components/studio/create/create-screen';

export const metadata: Metadata = { title: 'Create' };

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const reference = parseReference(first(params.reference), first(params.mode));
  return <CreateScreen initialReference={reference} />;
}
