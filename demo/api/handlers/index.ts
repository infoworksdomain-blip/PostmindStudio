// Registers every demo API area. Each module calls route(...) at import time.
// 15.D3 first: its multi-step POST /projects/:id/approve must match before projects-publish's.
import './p15-d-workflows';
// 15.A (Track A) before ./review: its GET /renders/:id adds thumbnailUrl.
import './p15-a-publishing';
import './projects';
import './review';
import './slideshow';
import './overlays';
import './library';
import './admin-library';
import './admin';
import './admin-cost';
import './analytics';
import './publications';
import './connections';
import './notifications';
import './business-profile';
import './business-scans';
import './business-brand-kits';
import './business-images';
import './p13-b-wave-b';
import './p13-a4-analytics';
import './p13-a1-uploads';
import './p13-a1-create-review';
import './p13-a3-admin';
import './p13-a2-library-business';
import './p13-a2-onboarding';
import './p13-a2-voice';
import './p15-d-features';
import './p15-d-admin-kill';
import './p15-d-admin-queues';
import './p15-d-tiers';
import './p15-d-library-admin';
import './p15-e-data-rights';
import './p15-c-planning';
import './p15-c-byoc';
import './p15-c-ratings';
import './p15-b-composition';
import './p14-t3-beta';
import './p14-t1-data-retention';
// Phase 17: coded failure reasons, the untitled project, extra publications.
import './p17-hardening';
// Phase 20.3: a video approved for the next free slot when none was free (schedule notice).
import './p20-schedule-month';
// Phase 18 Track E: /me, organisation settings, members, audit, admin directory, legal readiness,
// and sample data for Track C's billing contract.
import './p18-org';
import './p18-admin';
import './p18-billing';
// Review build: the admin Billing tab (entitlement overrides, MRR) and the account security page.
import './p18-admin-billing';
import './p18-account';
