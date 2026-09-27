import type { ReactNode } from 'react';

export const metadata = {
  title: 'PostMind Studio',
  description: 'AI video generation and multi-platform publishing for PostMind AI.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
