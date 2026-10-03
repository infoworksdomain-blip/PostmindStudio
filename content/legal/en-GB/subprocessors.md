<!-- Draft prepared 2026-09-30 from the providers the code actually integrates (src/lib/studio/providers/default-registry.ts, billing, email, storage, auth, observability, scan); brought in line with the product on 2026-10-03 (BACKLOG 20.28: Seedance, Kling and Veo video providers, Pixabay stock images, no content-safety provider since 20.21, transfer safeguards restated). Have a qualified solicitor review it. Before launch, confirm each provider's current contracting entity, processing region and transfer mechanism against its own DPA, and remove any provider whose key you do not configure. -->

# Sub-processors

**Last updated: 3 October 2026**

This page lists the third parties that Postmind AI Ltd uses to process personal data when providing PostMind Studio (the **Service**). It is referred to in our [Data Processing Agreement](/legal/dpa) and our [Privacy Policy](/legal/privacy).

**Transfer safeguards.** The UK recognises the EU and EEA as providing adequate protection, so no extra safeguard is needed for providers there. Where a provider processes personal data in another country without UK adequacy (for example the United States, Singapore, Malaysia or Australia), the tables show the safeguard we rely on:

- **DPF**: the UK Extension to the EU–US Data Privacy Framework (the "UK–US data bridge"), for a United States provider that is certified under it;
- **IDTA / Addendum**: where required, we rely on the UK International Data Transfer Addendum to the EU Standard Contractual Clauses, or the UK International Data Transfer Agreement (IDTA), in or alongside the provider's data processing terms.

"DPF or IDTA / Addendum" means we rely on the DPF where the provider is certified and otherwise on the IDTA or the Addendum.

<!-- LEGAL REVIEW (20.28, 2026-10-03): the safeguard column states the mechanism we intend to rely on; it does not claim that a signed IDTA or Addendum exists with each provider. For every row marked IDTA / Addendum or DPF, confirm (a) whether the provider is currently certified on the DPF list (dataprivacyframework.gov) with the UK Extension, and (b) that its DPA incorporates the UK Addendum or IDTA, and keep a transfer risk assessment. -->

## 1. Infrastructure

<!-- LEGAL REVIEW (20.28): Hetzner location. runbooks/vps-deploy.md and runbooks/go-live.md recommend Falkenstein or Nuremberg (Germany); the production server is recorded as Hetzner Helsinki (Finland). Both are in the EEA. Confirm the location of the production server and update this row, privacy 7.1 and DPA 10.1 / Annex 2 if it is not Helsinki. Cloudflare DNS was removed from the Cloudflare row because the production domain's DNS is recorded as hosted elsewhere; add it back if Cloudflare DNS or proxying is turned on. -->

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Hetzner Online GmbH | Hosting of the application servers and databases | All data held in the Service | Finland (Helsinki) | EEA |
| Cloudflare, Inc. | Object storage (R2) for uploads, generated media, stock images we have downloaded, and encrypted database and file backups | Files in Customer Content (images, video, audio, voice consent recordings), backups | Global infrastructure (R2 default location, no jurisdiction restriction): Cloudflare chooses where data is kept, and this may be outside the UK and EEA; company in the United States | DPF or IDTA / Addendum (Cloudflare's data processing addendum) <!-- LEGAL REVIEW: confirm Cloudflare's DPF certification and that its DPA includes the UK Addendum; R2 data may be stored in any Cloudflare region. --> |
| Amazon Web Services | Key Management Service: protects the keys that encrypt stored access tokens and similar secrets | Encrypted key material only; no readable personal data | United Kingdom (London, eu-west-2) | UK |
| Resend | Sending transactional and notification emails | Name, email address, email content, delivery events | Sending from the EU (Ireland region); company in the United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm Resend's DPF status and transfer terms for US support access. --> |
| Stripe | Payments, subscriptions, invoices, tax calculation and customer billing portal | Billing name, address, email, VAT number, payment method, payment history | Stripe Payments Europe, Ltd. (Ireland) and Stripe, Inc. (United States) | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm Stripe's DPF status and that its DPA includes the UK Addendum. --> |
| Functional Software, Inc. (Sentry) | Error reporting, **only if enabled** by us | Technical error details, which may include internal user and organisation IDs | United States (or EU region, depending on the account) | DPF or IDTA / Addendum <!-- LEGAL REVIEW: only if SENTRY_DSN is set; confirm the account region and transfer terms. --> |

## 2. AI generation and transcription

<!-- LEGAL REVIEW (20.24, 2026-10-02): the Kling row was added from Kling's "Terms of API Paid Service" (https://kling.ai/document-api/guides/protocols/paid-service, effective 2026-04-21: contract with Kling AI Pte. Ltd. and its affiliates; Kling acts as a data processor, does not train on API data, and logs prompts and responses for 30 days). Confirm the registered address, where Kling processes API data (the API endpoint is in Singapore), whether a DPA with SCCs / the UK Addendum is available, and that Singapore (no UK adequacy) is covered. -->

<!-- LEGAL REVIEW (20.23 / 20.28): BytePlus Pte. Ltd. is incorporated in Singapore; Seedance runs only in ap-southeast-1 (Johor, Malaysia). Neither Singapore nor Malaysia has UK adequacy. Confirm the BytePlus DPA and its transfer mechanism (IDTA or UK Addendum). Provider retention figures on this page and in the privacy policy come from the providers' API documentation cited in src/lib/studio/providers/seedance.ts, kling.ts and veo.ts (read 2026-10-02). -->

These providers receive the content needed for each step of making your videos. They process it to return a result to us, under business or API terms that we select so that, as far as those terms allow, they do not use it to train their models. We copy every generated clip, image and audio file into our own storage as soon as it is ready; the providers keep their own copies only for the limited time their terms set out (shown below where their documentation states it). We may change which provider handles a task, and video clips are tried with the providers in the order shown, moving to the next one when a provider is unavailable.

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Anthropic, PBC | Ideas, scripts, storyboards, captions and analysis of your business and website text | Briefs, prompts, business details and website text, including any personal data in them | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm Anthropic's DPF status and DPA transfer terms. --> |
| OpenAI | Text generation and embeddings (for search), image generation, and fallback audio transcription | Prompts, text, images and audio you provide or that are generated | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm OpenAI's DPF status and DPA transfer terms. --> |
| BytePlus Pte. Ltd. (ModelArk, Seedance) | AI video clip generation (main provider). Seedance refuses reference images that show real people's faces. Download links for results expire after 24 hours and task records are kept for 7 days | Prompts and, where used, reference images | Malaysia (ap-southeast-1, Johor data centre); company in Singapore. Content stopped by BytePlus's safety filter is kept for up to 180 days in Malaysia | IDTA / Addendum <!-- LEGAL REVIEW: Singapore and Malaysia have no UK adequacy; confirm the BytePlus DPA and transfer mechanism. --> |
| Kling AI Pte. Ltd. (Kling, a Kuaishou company) | AI video clip generation (second choice). Kling clears results after 30 days and keeps prompts and responses in its logs for 30 days | Prompts and, where used, reference images | Singapore (company; API endpoint api-singapore.klingai.com); processing location as set out in Kling's terms | IDTA / Addendum <!-- LEGAL REVIEW: Singapore has no UK adequacy; confirm whether Kling offers a DPA with the UK Addendum or IDTA, and its processing location. --> |
| Google LLC (Gemini API, Veo) | AI video clip generation (third choice). Google deletes generated videos from its servers after 2 days | Prompts and, where used, reference images | United States and other countries where Google processes Gemini API data | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm the Gemini API (paid tier) data processing terms and Google LLC's DPF status. --> |
| Runway AI, Inc. | AI video clip generation (further fallback) | Prompts and, where used, reference images | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm Runway's DPF status and DPA transfer terms. --> |
| Luma AI, Inc. | AI video clip generation (further fallback) | Prompts and, where used, reference images | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm Luma's DPF status and DPA transfer terms. --> |
| HeyGen | AI presenter (avatar) videos | Scripts and voice-over audio, and the presenter's image where one is supplied | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm HeyGen's contracting entity, DPF status and DPA transfer terms. --> |
| ElevenLabs | Voice-overs, music and sound; voice cloning on plans that include it | Script text; for voice cloning, the speaker's voice samples | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: confirm ElevenLabs' contracting entity, DPF status and DPA transfer terms. --> |
| AssemblyAI, Inc. | Speech transcription for captions and voice-consent checks | Audio, including voice consent recordings | European Union (EU region used in production); company in the United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: EU processing; confirm the transfer terms for any US access. --> |
| Shotstack Pty Ltd | Composition and rendering of the final videos | All media and text that make up a video, including images, video and voices of people | Australia (company); rendering location as set out in Shotstack's data processing terms | IDTA / Addendum <!-- LEGAL REVIEW: Australia has no UK adequacy; confirm Shotstack's rendering location and its DPA transfer mechanism. --> |

We do not use a content-scanning (moderation) service. Content safety relies on restricted-topic checks that run inside the Service, the safety filters the AI providers above apply to what they generate, and review by people.

## 3. Optional services

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Browserless | Hosted browser for scanning websites that refuse simple requests, **only if enabled** by us (by default we run this ourselves, or not at all) | Public content of the website you ask us to scan | United States | DPF or IDTA / Addendum <!-- LEGAL REVIEW: only if BROWSERLESS_API_KEY is set; confirm the transfer terms. --> |
| Your own providers (Enterprise) | If you connect your own accounts with the providers above ("bring your own credentials"), those providers process your content under **your** contract with them, not as our sub-processors | As above | As above | Your contract |

## 4. Services that do not receive personal data

- **Pixabay** supplies free stock images. We send it search keywords only. We download the images we use and store them in our own storage with the business's image library, with a credit to Pixabay.
- **Storyblocks and Pexels** can supply stock footage, images, music and sound effects, **only if enabled** by us. We send them search keywords only.
- **Unsplash** is not used at present. We may add it as a stock image source in future and will update this page first.
- **Have I Been Pwned (Pwned Passwords)** checks whether a new password has appeared in a known breach. We send only the first five characters of a hash of the password, never the password or your email address.
- **Google Fonts** supplies fonts to your browser when you preview text in the video editor; your browser, not our servers, makes that request (see our [Cookie Policy](/legal/cookies)).

## 5. Connected Platforms (not sub-processors)

When you connect an account and ask us to publish or read analytics, the following receive your content and account details as **independent controllers** under their own terms and privacy policies. They are not our sub-processors, because you choose to use them and they decide how they use the data:

- **TikTok** (TikTok Technology Limited / TikTok Inc., depending on your region)
- **Meta** (Instagram and Facebook; Meta Platforms Ireland Limited for the UK and EU)
- **Google** (YouTube, and "Continue with Google" sign-in; Google Ireland Limited for the UK and EU)
- **X** (X Corp. or its affiliate for your region)
- **LinkedIn** (LinkedIn Ireland Unlimited Company for the UK and EU)

## 6. Changes to this list

We will update this page at least 30 days before a new sub-processor starts processing personal data, and we will tell the owners of every Organisation by email or in the Service. You may object as described in clause 5.3 of the [Data Processing Agreement](/legal/dpa). Questions: support@postmindai.pro.
