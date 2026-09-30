<!-- Draft prepared 2026-09-30 from the providers the code actually integrates (src/lib/studio/providers/default-registry.ts, billing, email, storage, auth, observability, scan). Have a qualified solicitor review it, and fill in every double-bracket marker (content/legal/FILL-IN.md). Before launch, confirm each provider's current contracting entity, processing region and transfer mechanism against its own DPA, and remove any provider whose key you do not configure. -->

# Sub-processors

**Last updated: 30 September 2026**

This page lists the third parties that Postmind AI Ltd uses to process personal data when providing PostMind Studio (the **Service**). It is referred to in our [Data Processing Agreement](/legal/dpa) and our [Privacy Policy](/legal/privacy).

**Transfer safeguards.** Where a provider below is outside the UK and EEA, transfers rely on the UK Extension to the EU–US Data Privacy Framework or the EU–US Data Privacy Framework where the provider is certified, and otherwise on the EU Standard Contractual Clauses with the UK International Data Transfer Addendum (or the UK International Data Transfer Agreement) in the provider's data processing terms. In the tables this is shown as **SCCs / DPF**. The EU and EEA have UK adequacy, so no extra safeguard is needed for them.

## 1. Infrastructure

| Sub-processor                      | Purpose                                                                                         | Personal data processed                                                             | Location                                                                                                          | Safeguard                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Hetzner Online GmbH                | Hosting of the application servers and databases                                                | All data held in the Service                                                        | Finland (Helsinki)                                                                                                | EEA                                                |
| Cloudflare, Inc.                   | Object storage (R2) for uploads, generated media and encrypted database and file backups; DNS   | Files in Customer Content (images, video, audio, voice consent recordings), backups | Global infrastructure: location chosen by Cloudflare, may be outside the UK and EEA; company in the United States | SCCs / DPF (Cloudflare's data processing addendum) |
| Amazon Web Services                | Key Management Service: protects the keys that encrypt stored access tokens and similar secrets | Encrypted key material only; no readable personal data                              | United Kingdom (London region)                                                                                    | UK                                                 |
| Resend                             | Sending transactional and notification emails                                                   | Name, email address, email content, delivery events                                 | Sending from the EU (Ireland region); company in the United States                                                | SCCs / DPF                                         |
| Stripe                             | Payments, subscriptions, invoices, tax calculation and customer billing portal                  | Billing name, address, email, VAT number, payment method, payment history           | Stripe Payments Europe, Ltd. (Ireland) and Stripe, Inc. (United States)                                           | SCCs / DPF                                         |
| Functional Software, Inc. (Sentry) | Error reporting, **only if enabled** by us                                                      | Technical error details, which may include internal user and organisation IDs       | United States (or EU region, depending on the account)                                                            | SCCs / DPF                                         |

## 2. AI generation, transcription and content safety

These providers receive the content needed for each step of making your videos. They process it to return a result to us, under business or API terms that we select so that, as far as those terms allow, they do not use it to train their models.

| Sub-processor              | Purpose                                                                                         | Personal data processed                                                                 | Location                                                                                | Safeguard  |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| Anthropic, PBC             | Ideas, scripts, storyboards, captions and analysis of your business and website text            | Briefs, prompts, business details and website text, including any personal data in them | United States                                                                           | SCCs / DPF |
| OpenAI                     | Image generation, text generation and embeddings (for search), and fallback audio transcription | Prompts, text, images and audio you provide or that are generated                       | United States                                                                           | SCCs / DPF |
| Runway AI, Inc.            | AI video clip generation                                                                        | Prompts and reference images                                                            | United States                                                                           | SCCs / DPF |
| Luma AI, Inc.              | AI video clip generation                                                                        | Prompts and reference images                                                            | United States                                                                           | SCCs / DPF |
| HeyGen                     | AI presenter (avatar) videos                                                                    | Scripts and voice-over audio                                                            | United States                                                                           | SCCs / DPF |
| ElevenLabs                 | Voice-overs, music and sound; voice cloning on plans that include it                            | Script text; for voice cloning, the speaker's voice samples                             | United States                                                                           | SCCs / DPF |
| Shotstack Pty Ltd          | Composition and rendering of the final videos                                                   | All media and text that make up a video, including images, video and voices of people   | Australia (company); rendering location as set out in Shotstack's data processing terms | SCCs       |
| Castle Global, Inc. (Hive) | Automated content-safety checks                                                                 | Images, video frames and text being checked                                             | United States                                                                           | SCCs / DPF |
| AssemblyAI, Inc.           | Speech transcription for captions and voice-consent checks                                      | Audio, including voice consent recordings                                               | European Union (EU region used in production); company in the United States             | SCCs / DPF |

## 3. Optional services

| Sub-processor                   | Purpose                                                                                                                                                                                     | Personal data processed                          | Location      | Safeguard     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------- | ------------- |
| Browserless                     | Hosted browser for scanning websites that refuse simple requests, **only if enabled** by us (by default we run this ourselves, or not at all)                                               | Public content of the website you ask us to scan | United States | SCCs / DPF    |
| Your own providers (Enterprise) | If you connect your own accounts with the providers above ("bring your own credentials"), those providers process your content under **your** contract with them, not as our sub-processors | As above                                         | As above      | Your contract |

## 4. Services that do not receive personal data

- **Storyblocks, Pexels and Unsplash** supply stock footage, images, music and sound effects. We send them search keywords only.
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
