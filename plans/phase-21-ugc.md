# Phase 21.4 — UGC actor videos

Operator request (2026-10-04): "I also want videos that are actually actors: UGC-style videos
where actors talk about products." A realistic generated person speaks to camera about the
business's product (customer-testimonial / creator-review style): handheld or selfie framing,
natural delivery, the product in view where possible, lips matching the spoken line.

Scope change the same day (operator decision): plan tiers are replaced by a per-channel
subscription (every channel maps to STANDARD internally). UGC is therefore **not gated by tier**;
a UGC video instead **uses 2 videos** of the allowance or packs, and no cost is ever shown.

## A. Research (official docs and pricing pages, all read 2026-10-04)

| Option | Speech + lip-sync | Product in view | 9:16 | Clip lengths | List price | 30 s UGC video | New account / key? | Actor likeness for ads |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Google Veo 3.1 Fast** (Gemini API) | Native audio "always on"; prompt guide: "Use quotes for specific speech", model makes "a synchronized soundtrack". Lip-sync accuracy **not documented**. English "fully supported", other languages "not evaluated". | `referenceImages`: "up to three asset images of a single person, character, or product" (forces 8 s, `allow_adult`) | yes | 4 / 6 / 8 s | $0.10/s at 720p, audio included | 3 × 8 s = **$2.40** (with product reference) | **No** — `GOOGLE_GEMINI_API_KEY`, billing already active | Generated people; Google "won't claim ownership" of output; SynthID watermark; EEA/UK apps must use Paid Services (we do) |
| Veo 3.1 Standard | same | same | yes | same | $0.40/s at 720p | $9.60–12.80 | no | same |
| Veo 3.1 Lite | same; `referenceImages` marked n/a (page contradicts itself) | unclear | yes | same | $0.05/s | $1.50 (no reference) | no | same |
| **Kling 3.0** text-to-video, `settings.audio: "native"` | Native audio documented; dialogue / lip-sync guidance **not documented** | no reference input (first frame only) | yes | 3–15 s | 0.9 units/s = $0.126/s at 720p | 24 s ≈ **$3.02** | No — existing `KLING_API_KEY`; the resource package must cover native audio | per Kling paid-service terms; not ad-specific |
| Kling Lip Sync / Avatar / **Video Commerce** (`/solutions/talking_agent`) | Lip-sync to supplied audio (one person); Video Commerce: avatar image + script → talking video, product shots from `ref_image` | Video Commerce: yes | yes | system-chosen | Commerce 1.4 units/s (product) ≈ $5.88 / 30 s | $4.20–6.72 | same key, but needs a character image and returns a whole video (not per shot) | not documented |
| HeyGen Avatar IV (`POST /v3/videos`) | Lip-sync to audio | "product" only via Video Agent prompt; product-in-hand not documented | yes | any | ≈ $0.05/s (enterprise page / blog) | ≈ $1.50 | Our HeyGen API credit is exhausted | Paid plans: commercial use, AI disclosure required |
| Creatify (public API) | AI Avatar v2 / Aurora lip-sync | marketing page says avatars "hold products"; not in the API docs | 9:16 for avatar; product-to-video 16:9 | — | API plans $99/500 credits, $299/2,000 | $0.75–5.94 depending on endpoint | **New account + key** | no ad-rights page found |
| Arcads | — | marketing claims "avatar holding your product" | — | — | not public | — | **API only on a custom contract** | licence forbids cloning likeness / misleading ads |
| Captions / Mirage (`mirage-avatar-x`) | video/image + audio → talking video | not documented | yes | 6 s billing steps | $0.15/s | $4.50–7.20 | **New account + key** | not documented |

Sources: ai.google.dev/gemini-api/docs/veo (updated 2026-09-17), ai.google.dev/gemini-api/docs/pricing,
ai.google.dev/gemini-api/terms; kling.ai/document-api/apiReference/model/textToVideo,
kling.ai/document-api/pricing/base/video, kling.ai/dev/pricing,
kling.ai/document-api/apiReference/model/lipSync, kling.ai/document-api/api/video/avatar,
kling.ai/document-api/api/ecommerce-replication/video-commerce; developers.heygen.com (avatar-iv,
enterprise-pricing, e-commerce-product-videos), heygen.com/terms; docs.creatify.ai/billing.md,
creatify.ai/features/ai-avatar; arcads.ai/terms; captions.ai/help/api-reference,
captions.ai/help/docs/api/pricing.

### Recommendation

**Google Veo 3.1 Fast through the Gemini API**, with the key and billing we already have. It is the
only option that generates the actor, the speech and the product in one call per shot (dialogue in
quotes, product as an asset reference image), at $0.10/s including audio — about **£1.80 of actor
clips for a 30 s video** (3 × 8 s). No dedicated UGC API is clearly better: the cheaper ones
(HeyGen, Creatify AI Avatar) lip-sync stock avatars to separate audio and do not document a product
in hand, and every dedicated one needs a new account (HeyGen is out of credit, Arcads has no
self-serve API).

**Kling 3.0 with native audio** is built as the opt-in fallback behind config
(`KLING_UGC_ACTOR=1`), on the Kling key we already have. It stays off until the operator has
judged a few clips: Kling does not document dialogue syntax or lip-sync quality.

Not built (needs operator keys and a decision): Creatify, Mirage and Kling Video Commerce. Each
would be one more `actor_video` adapter (the pipeline is provider-agnostic): Kling Video Commerce
and HeyGen would first need a generated actor image (a Veo/Imagen still) and return lip-sync to
our own script, so they are a second phase if Veo's lip-sync disappoints.

## B. What is built

- **Style**: Create → Options → "UGC actor" (every subscriber). Optional product name (suggested
  from the business profile), product photo (the business's image library), actor look (age range,
  person, setting) from preset lists. Stored as `metadata.ugc` with a per-project seed
  (`src/lib/studio/ugc/style.ts`). "UGC video · uses 2 of your videos" is shown; no cost.
  "Plan my month" has "Make testimonial and product videos with UGC actors" (testimonial and
  product-feature angles; `ugc/plan-month.ts`).
- **Rules**: brief only, short-form (≤ 60 s), English (Veo's evaluated language), never a real
  person (`ugc/real-person.ts` at create/edit/generate, plus the ideation flag
  `realPersonRequested` before Layer 2; refusal reason `ugc_real_person_refused`, translated).
- **Layers 1–2**: UGC ideation supplement (first-person creator review, hook in 2 s, no claims to
  be a real customer) and UGC script supplement (problem → product → result → CTA, clip lengths
  with word limits); treatments limited to `UGC_ACTOR` + product still / card. After parsing
  (`ugc/plan.ts`): actor clips snapped to Veo lengths (8 s with the product reference), at most the
  actor budget (STANDARD one per 10 s, PLUS one per 7.5 s, 2–8, and they must fit the video),
  B-roll lines moved on screen (only the actor speaks, one voice).
- **Prisma**: `VisualTreatment.UGC_ACTOR` (expand-only migration `20261008010000_ugc_actor_treatment`).
- **Layer 3**: new capability `actor_video` (`ActorVideoRequest`: scene prompt, spoken line,
  language, product image URL, seed). Veo adapter: line in quotes, `referenceImages` (asset) with
  8 s + `allow_adult`, `seed`. The same actor description (age, person, hair, clothes from the
  seed) is repeated word for word in every clip. Router: `veo → kling` (Kling only with
  `KLING_UGC_ACTOR=1`). No ElevenLabs voice for actor shots. No actor provider available (account
  problem, kill switch, hold) → the shot degrades like an avatar shot: brand voice over B-roll,
  noted on the review screen (`actor_video`).
- **Speech, captions, gate**: the clip is transcribed (AssemblyAI) and its fit stored on the clip
  asset (`ugc/clip-speech.ts`); captions, karaoke and caption_sync read the clip's words; the
  composer keeps the clip's audio (volume 1), ducks music under it and moves headlines to the top;
  the summary marks `speech: 'clip'` and audio_sync checks that the actor's last word ends in the
  shot. The AI-generated label is always on for UGC videos.
- **Cost**: Veo actor clips at list price; default UGC project budget STANDARD £6.00,
  PLUS/ENTERPRISE £7.50 (2.5 × typical, `ugc/cost.ts`); allowance units 2 (`ugc/allowance.ts`,
  counted in plan-quotas and pack credits). Cost guards and the kill switch apply unchanged (every
  call goes through runProvider).

## C. Arithmetic (STUDIO_USD_TO_GBP_RATE 0.75)

- 30 s UGC video: 3 × 8 s × $0.10 = $2.40 → 180p of actor clips; text, transcription, music and
  Shotstack ≈ 50p → **≈ 230p**. Kling fallback: 24 s × $0.126 = $3.02 → 227p + ≈ 50p.
- 45 s PLUS: 5 × 8 s = 40 s → 300p + ≈ 55p. 60 s: 7 × 8 s → 420p + ≈ 60p.
- Ordinary HD short (20.25 model): ≈ 141p typical, up to ≈ £2.20 → a UGC video counts as **2**.
- Budget: 2.5 × 230p = 575p → **£6.00**; a normal UGC video uses ≈ 40% of it.

## D. Operator actions

1. Nothing new to buy: Veo uses `GOOGLE_GEMINI_API_KEY` (billing already on). Check the project's
   Gemini API spend cap allows ≈ £2.50 per UGC video.
2. Make one UGC video on staging and judge lip-sync, voice consistency between clips and the
   product in hand. Lip-sync quality is not documented by Google.
3. Optional: set `KLING_UGC_ACTOR=1` only after judging Kling actor clips (its resource package
   must include native audio).
4. Optional: other languages — Veo has not evaluated them; widen `UGC_LANGUAGES` after a test.

## E. Known limits / follow-ups

- Each clip is a separate generation: the same described person and seed keep the look close but
  voice and face may drift between clips. A follow-up could pass the first clip's frame as a
  reference image (Veo allows up to 3; the product uses one).
- DOC DISCREPANCY (as in 20.20): the REST samples write images as `inlineData`, the official SDK
  as `{ bytesBase64Encoded, mimeType }`; we follow the SDK. Confirm on the first live run.
- An actor line that runs past its clip fails audio_sync (a clip cannot be re-paced); the script
  word limits make that rare.
