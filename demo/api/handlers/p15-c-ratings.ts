// P7 (Addendum A3.6 step 3) — GET /businesses/:id/provider-ratings sample handler. Shape matches
// src/app/api/studio/businesses/[id]/provider-ratings/route.ts (services/provider-ratings.ts
// ProviderRating). Sample numbers follow the real formula: 0.4·approval + 0.3·(1 − regeneration)
// + 0.3·retention(25 %→0 … 60 %→1), over the components that have data.
import { DEMO_BUSINESS_ID } from '../ids';
import { route } from '../registry';

const ratings = [
  {
    providerId: 'runway',
    score: 0.861,
    components: { approvalRate: 0.9, regenerationRate: 0.1, retention: 0.52 },
    sampleShots: 24,
    routed: true,
  },
  {
    providerId: 'luma',
    score: 0.7,
    components: { approvalRate: 0.7, regenerationRate: 0.3, retention: null },
    sampleShots: 11,
    routed: true,
  },
  {
    providerId: 'openai',
    score: 0.5,
    components: { approvalRate: null, regenerationRate: 0.5, retention: null },
    sampleShots: 6,
    // Also Studio's text fallback, so its image rating is shown but not used for routing.
    routed: false,
  },
];

route('GET', '/businesses/:id/provider-ratings', ({ params }) => ({
  scores: params.id === DEMO_BUSINESS_ID ? ratings : [],
}));
