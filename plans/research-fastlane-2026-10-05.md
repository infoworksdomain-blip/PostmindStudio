# Fastlane (usefastlane.ai): how it makes content (research 2026-10-05)

Operator request, 2026-10-05: "Review how Fastlane generates their videos and replicate the video generation process."

Each claim is tagged confirmed, likely or guess. Main sources:
- API: https://developers.usefastlane.ai/#endpoints
- MCP: https://developers.usefastlane.ai/#mcp
- Founder demos: https://www.youtube.com/watch?v=VYcsTOiM0-c and https://www.youtube.com/watch?v=CIT3KBQ5_MA
- Tutorial: https://www.youtube.com/watch?v=65HrL27JyKU
- Review: https://www.youtube.com/watch?v=Oq9qn0Hzg9I
- Product Hunt: https://www.producthunt.com/products/fastlane-3

Their showcase videos were also inspected frame by frame on 2026-10-05.

## Formats
Four core render types are confirmed in the API: `slideshow`, `wall-of-text`, `green-screen` and `video-hook`. Blitz chooses between them by weights that add up to 100 (25 each by default).

- **video-hook (hook + demo)**
  - Built on a 1080×1920 canvas from a `hook_video`, a user-uploaded `demo_video`, an `audio` track (music, mixed against the demo audio with `audioMix`) and one text object.
  - Founder: "a shocked reaction with some text and then demoing the app immediately after".
  - If the workspace has no demo video, the request fails with `no_demo_video`. Demos are always uploaded by the user and never generated.
- **wall-of-text**: a background video, a track from the curated audio library, and one large block of text.
- **green-screen meme**: a cut-out clip composited over a background image, with a caption. The clip's own audio is kept. **Not copied by Studio:** it reuses copyrighted footage and real people's likenesses.
- **slideshow**
  - Up to 20 image slides, each with its own text boxes.
  - Aspect ratio 1:1, 4:5 (default), 3:4 or 9:16.
  - Structure: a hook slide, one idea per slide in large text, then a closing slide that names the product. They recommend 5–10 slides.
  - Images come from the user's Media Bank (`slideshow-image`) or the shared library, chosen to fit the niche.
  - Posted as a TikTok photo post or an Instagram carousel.
- **Talking-head AI UGC (AI influencer)** can be used with slideshow, wall-of-text and video-hook. Green-screen always uses regular content.
- **Timing**: the hook lands in the first 1–3 s with 6–12 spoken words. Scripts run 15–30 s.

## Pipeline
1. **Onboarding.** The user gives a name, company, logo, and a website or App Store URL (analysis takes about 5 s) or a free-text description. A short survey follows.
2. **Company profile.** Market, differentiators, competitors and tone, plus RAG context. The brand's voice is copied from its website. A Brand tab holds tone dos and don'ts.
3. **Angles.** Each angle has a title, a description and a target audience, up to 100 per workspace. An AI suggests new angles without repeating existing titles, and angle weights control how often each is used.
4. **Suggestion queue.** About 5 suggestions are kept per workspace. Each holds the caption copy, a content type and `aiExplanation`, which is shown in the UI as "Why this content works".
5. **Remix vs original.**
   - `remixPercentage` sets how many suggestions remix a trending reference.
   - A remix keeps its `remixSourceUrl`, the UI shows the source video beside the output, and it follows the trend's structure with the brand's copy swapped in.
   - Footage is only reused for memes.
6. **Media selection.**
   - `ownMediaPercentage` sets the split between the user's Media Bank and the shared library.
   - Image categories: `slideshow-image`, `green-screen-background`.
   - Video categories: `background-video`, `hook-video`, `green-screen-video`.
7. **Render.** An asynchronous server-side compositor lays out the media layers and text boxes in roughly 30 s to a few minutes. Uploads are normalised (MOV to MP4, HDR to SDR, faststart).
8. **Review.**
   - Swipe in Blitz, then edit in the Studio: text, font, colour, background, position, swapping the image or avatar, or regenerating the copy with an optional prompt.
   - Then save or schedule.

## Cost model
- Formats are assembled from existing media, LLM copy and a compositor, so no paid video generation happens for each post.
- AI Studio costs 4 credits per image and 10 credits per second of video. Characters are generated once and then reused.
- Fastlane does not disclose its models. A `soulId` field suggests a per-character identity model (guess).

## AI influencers
- Created from a name, gender, age and ethnicity, or an uploaded base image. Generating one costs 4 credits, and it can be regenerated with extra instructions.
- Status moves `generating_variations` → `training` → `ready`, building "a massive consistent stack" of images.
- Up to 50 per workspace, and each can be linked to up to 10 angles.
- `influencerChance` (default 50 %) sets how often a post uses an influencer, with a gender filter.
- There are about 1,000 pre-made characters and about 2,000 real human UGC clips.

## Audio and posting
- Curated audio libraries exist for wall-of-text and video-hook. Users cannot upload their own audio.
- TikTok posts go to the inbox by default (`posting_mode` "inbox"), so the user adds a trending sound in the app. "direct" posting needs an entitlement.
- Each platform gets its own AI-written caption.

## Blitz (swipe)
- Shows one item per swipe. Swipe right to save or schedule; swipe left to skip.
- Capped by daily swipes and by content saves.
- The source trend is shown beside a remix, along with "Why this content works".

## Automations
- A campaign moves DRAFT → GENERATING → REVIEW → BUILDING → ACTIVE → COMPLETED.
- Cadence is 1–3 posts per account per day, for 1–4 weeks.
- When the campaign starts, it snapshots the content-mix preferences: type weights, remix %, angle weights, caption-style weights and video-hook audio mix.
- In review, single slots can be edited or rerolled.
- A slot fails on a duplicate (`no_unique_content`) or when there is no demo video.
- Weekly insights recommend what to make more of.

## Copywriting
- **Hook types:** call-out, result-first, contrarian, curiosity gap, mistake, question, story-open, pattern interrupt.
- **Formula:** who it is for, what they get, why now. Use real numbers. On-screen text is a shorter version of the spoken line.
- **Mapping from website to formats:** value proposition → hook + demo; each benefit → a UGC piece; FAQs → text explainers; pricing → slideshow; competitors → memes.
- **Caption style presets:** `tiktok-classic` (white, 2–3 px black stroke, no box, Montserrat 600–700), `bold-impact`, `snapchat`, `white-box`, `yellow-pop`, `clean-karaoke`, `script-playful`. `smartTextPositioning` varies the position within the safe area.
- A "mention business" percentage controls how often the brand is named.

## Showcase observations (frames, 2026-10-05)
- **(a)** An AI creator's reaction hook with one tiktok-classic caption, then real product B-roll (a hand holding a phone showing the app) with no text card.
- **(b)** A green-screen cut-out with the caption above it.
- **(c)** A person filmed in context, with a multi-line caption block on the torso and the face left clear.
