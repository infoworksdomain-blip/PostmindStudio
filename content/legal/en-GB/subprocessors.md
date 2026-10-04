<!-- Operator text. Lists the providers the code integrates (src/lib/studio/providers/default-registry.ts, billing, email, storage, auth, observability, scan). Legal scope closed 2026-10-04 (operator decision, BACKLOG 21.2). Keep this page in step with the providers configured in production, and give 30 days' notice of a new sub-processor (section 6). Provider retention figures come from the providers' API documentation cited in src/lib/studio/providers/seedance.ts, kling.ts and veo.ts. -->

# Sub-processors

**Last updated: 4 October 2026**

This page lists the third parties that Postmind AI Ltd uses to process personal data when providing PostMind Studio (the **Service**). It is referred to in our [Data Processing Agreement](/legal/dpa) and our [Privacy Policy](/legal/privacy).

**Transfer safeguards.** The UK recognises the EU and EEA as providing adequate protection, so no extra safeguard is needed for providers that process personal data there. Where a provider processes personal data in a country without a UK adequacy decision (the United States, Singapore, Malaysia or Australia), we rely on the European Commission's Standard Contractual Clauses with the UK International Data Transfer Addendum, as incorporated in that provider's data processing terms, together with a transfer risk assessment we keep on file. The tables show this as **SCCs + UK Addendum**.

## 1. Infrastructure

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Hetzner Online GmbH | Hosting of the application servers and databases | All data held in the Service | Helsinki, Finland (EU) | EU (UK adequacy) |
| Cloudflare, Inc. | Object storage (R2) for uploads, generated media, stock images we have downloaded, and encrypted database and file backups | Files in Customer Content (images, video, audio, voice consent recordings), backups | Global infrastructure (R2 default location, no jurisdiction restriction): Cloudflare chooses where data is kept, and this may be outside the UK and EEA; company in the United States | SCCs + UK Addendum, as incorporated in Cloudflare's data processing terms; transfer risk assessment on file |
| Amazon Web Services | Key Management Service: protects the keys that encrypt stored access tokens and similar secrets | Encrypted key material only; no readable personal data | United Kingdom (London, eu-west-2) | UK |
| Resend | Sending transactional and notification emails | Name, email address, email content, delivery events | Sending from the EU (Ireland region); company in the United States | SCCs + UK Addendum, as incorporated in Resend's data processing terms; transfer risk assessment on file |
| Stripe | Payments, subscriptions, invoices, tax calculation and customer billing portal | Billing name, address, email, VAT number, payment method, payment history | Stripe Payments Europe, Ltd. (Ireland) and Stripe, Inc. (United States) | SCCs + UK Addendum, as incorporated in Stripe's data processing terms; transfer risk assessment on file |
| Functional Software, Inc. (Sentry) | Error reporting, **only if enabled** by us | Technical error details, which may include internal user and organisation IDs | United States (or EU region, depending on the account) | SCCs + UK Addendum, as incorporated in Sentry's data processing terms; transfer risk assessment on file |

## 2. AI generation and transcription

These providers receive the content needed for each step of making your videos. They process it to return a result to us, under business or API terms that we select so that, as far as those terms allow, they do not use it to train their models. We copy every generated clip, image and audio file into our own storage as soon as it is ready; the providers keep their own copies only for the limited time their terms set out (shown below where their documentation states it). We may change which provider handles a task, and video clips are tried with the providers in the order shown, moving to the next one when a provider is unavailable.

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Anthropic, PBC | Ideas, scripts, storyboards, captions and analysis of your business and website text | Briefs, prompts, business details and website text, including any personal data in them | United States | SCCs + UK Addendum, as incorporated in Anthropic's data processing terms; transfer risk assessment on file |
| OpenAI | Text generation and embeddings (for search), image generation, and fallback audio transcription | Prompts, text, images and audio you provide or that are generated | United States | SCCs + UK Addendum, as incorporated in OpenAI's data processing terms; transfer risk assessment on file |
| BytePlus Pte. Ltd. (ModelArk, Seedance) | AI video clip generation (main provider). Seedance refuses reference images that show real people's faces. Download links for results expire after 24 hours and task records are kept for 7 days | Prompts and, where used, reference images | Malaysia (ap-southeast-1, Johor data centre); company in Singapore. Content stopped by BytePlus's safety filter is kept for up to 180 days in Malaysia | SCCs + UK Addendum, as incorporated in BytePlus's data processing terms; transfer risk assessment on file |
| Kling AI Pte. Ltd. (Kling, a Kuaishou company) | AI video clip generation (second choice). Kling clears results after 30 days and keeps prompts and responses in its logs for 30 days | Prompts and, where used, reference images | Singapore (company; API endpoint api-singapore.klingai.com); processing location as set out in Kling's terms | SCCs + UK Addendum, as incorporated in Kling's data processing terms; transfer risk assessment on file |
| Google LLC (Gemini API, Veo) | AI video clip generation (third choice) and UGC actor videos (an AI-generated person speaking the script). Google deletes generated videos from its servers after 2 days | Prompts, scripts and, where used, reference images (for UGC actor videos, the product photo you choose) | United States and other countries where Google processes Gemini API data | SCCs + UK Addendum, as incorporated in Google's data processing terms; transfer risk assessment on file |
| Runway AI, Inc. | AI video clip generation (further fallback) | Prompts and, where used, reference images | United States | SCCs + UK Addendum, as incorporated in Runway's data processing terms; transfer risk assessment on file |
| Luma AI, Inc. | AI video clip generation (further fallback) | Prompts and, where used, reference images | United States | SCCs + UK Addendum, as incorporated in Luma's data processing terms; transfer risk assessment on file |
| HeyGen | AI presenter (avatar) videos | Scripts and voice-over audio (the presenter is a licensed stock presenter supplied by HeyGen; no customer images are sent) | United States | SCCs + UK Addendum, as incorporated in HeyGen's data processing terms; transfer risk assessment on file |
| ElevenLabs | Voice-overs, music and sound; voice cloning on plans that include it | Script text; for voice cloning, the speaker's voice samples | United States | SCCs + UK Addendum, as incorporated in ElevenLabs' data processing terms; transfer risk assessment on file |
| AssemblyAI, Inc. | Speech transcription for captions and voice-consent checks | Audio, including voice consent recordings | European Union (EU region used in production); company in the United States | SCCs + UK Addendum, as incorporated in AssemblyAI's data processing terms; transfer risk assessment on file |
| Shotstack Pty Ltd | Composition and rendering of the final videos | All media and text that make up a video, including images, video and voices of people | Australia (company); rendering location as set out in Shotstack's data processing terms | SCCs + UK Addendum, as incorporated in Shotstack's data processing terms; transfer risk assessment on file |

We do not use a content-scanning (moderation) service. Content safety relies on restricted-topic checks that run inside the Service, the safety filters the AI providers above apply to what they generate, and review by people.

## 3. Optional services

| Sub-processor | Purpose | Personal data processed | Location | Safeguard |
| --- | --- | --- | --- | --- |
| Browserless | Hosted browser for scanning websites that refuse simple requests, **only if enabled** by us (by default we run this ourselves, or not at all) | Public content of the website you ask us to scan | United States | SCCs + UK Addendum, as incorporated in Browserless's data processing terms; transfer risk assessment on file |
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
