import { redirect } from 'next/navigation';

// studio.postmind.ai opens on the projects list (spec 14.3 manage surface).
export default function Home(): never {
  redirect('/projects');
}
