import { ArrowUpRight } from 'lucide-react';
import { FEATURE_SECTIONS } from './features-data';
import { Chapter, Pill, TourHeader, Toc, useSectionScroll } from './ui';

// #/tour/features — "Everything built": every completed feature of Phases 1–18 by area, each with
// a one-line description and a "See it" link (features-data.ts).

export function FeaturesPage() {
  useSectionScroll();
  const total = FEATURE_SECTIONS.reduce((sum, s) => sum + s.features.length, 0);
  return (
    // English-only tour text: kept left-to-right in every interface language.
    <div lang="en" dir="ltr">
      <TourHeader
        eyebrow="PostMind Studio · review build"
        title={
          <>
            Everything built, <em className="text-primary">in one place.</em>
          </>
        }
        lede={
          <p>
            {total} features from Phases 1 to 18 in {FEATURE_SECTIONS.length} areas. “See it” opens
            the screen or state that shows each one; features without a screen open the behind-the-
            scenes page at the right chapter. What is still missing is on{' '}
            <a className="text-foreground underline underline-offset-4" href="#/tour/not-built">
              Not built yet
            </a>
            .
          </p>
        }
      >
        <Toc items={FEATURE_SECTIONS.map((s) => ({ id: `features-${s.id}`, label: s.label }))} />
      </TourHeader>
      {FEATURE_SECTIONS.map((section, i) => (
        <Chapter
          key={section.id}
          id={`features-${section.id}`}
          index={String(i + 1).padStart(2, '0')}
          title={section.label}
        >
          <ul className="divide-y divide-border/70 rounded-xl border border-border bg-card">
            {section.features.map((f) => (
              <li
                key={f.title}
                className="grid gap-x-4 gap-y-1 p-3 text-sm wrap-anywhere sm:grid-cols-[14rem_1fr_auto] sm:items-baseline md:p-4"
              >
                <span className="font-medium">{f.title}</span>
                <span className="text-muted-foreground">
                  {f.description} <Pill>{f.phase}</Pill>
                </span>
                <a
                  href={f.href}
                  aria-label={`See it: ${f.title}`}
                  className="inline-flex items-center gap-0.5 justify-self-start font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  See it <ArrowUpRight aria-hidden className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        </Chapter>
      ))}
    </div>
  );
}
