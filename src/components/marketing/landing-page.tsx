import { Formats } from './landing/formats';
import { Hero } from './landing/hero';
import { RevealOnScroll } from './landing/motion';
import { Autopilot, PlanSchedule, PublishEverywhere } from './landing/workflow';
import { BrandAndApprovals, Closing, Insights, PricingTeaser } from './landing/proof';
import { VideoGeneration } from './landing/video-generation';

// Phase 18 §3 / 25.5 — the public landing page at `/`, in the Daylight and Darkroom system:
// Geist, neutral surfaces, one vermilion record dot. Every picture and clip is real PostMind
// Studio output (public/marketing/SOURCES.md; the businesses are fictional) or a real product
// screen. Sections (landing/*): hero, formats strip, video generation, plan and schedule, publish
// everywhere, month planner / Blitz / automations, analytics, brand kit and approvals, pricing
// teaser, closing call to action. Every string is in the `marketing` namespace.

export function LandingPage() {
  return (
    <RevealOnScroll>
      <Hero />
      <Formats />
      <VideoGeneration />
      <PlanSchedule />
      <PublishEverywhere />
      <Autopilot />
      <Insights />
      <BrandAndApprovals />
      <PricingTeaser />
      <Closing />
    </RevealOnScroll>
  );
}
