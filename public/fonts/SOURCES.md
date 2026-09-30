# Render fonts (BACKLOG 20.7)

Shotstack has no system fonts, and the FFmpeg overlay pre-renderer and thumbnail composer download
their font too, so every family Studio names in a render is fetched as
`<fonts base>/<FamilyWithoutSpaces>.ttf`. Studio serves this folder itself: Next.js serves `public/`
from the site root, so the files are at `https://<domain>/fonts/<Family>.ttf`, and the fonts base
defaults to `APP_URL/fonts` (`src/lib/studio/fonts-host.ts`). `STUDIO_FONTS_BASE_URL` overrides it
(a CDN must then serve the same files).

`test/unit/self-hosted-fonts.test.ts` checks that every family the code can put into a render (the
overlay presets and default style, the script → Noto map, the onboarding font picker, the
thumbnail font, and every `fontFamily` / `fontPrimary` / `fontSecondary` literal in `src/` and
`demo/`) has its file here, and that each file is a TrueType font whose
family name is exactly the family Studio asks for, whose default instance is Regular (weight 400;
FFmpeg drawtext draws a variable font's default instance), with a licence in `licenses/` and a
line below.

## Where the files come from

All files were downloaded on 2026-09-30 from the official Google Fonts repository,
[github.com/google/fonts](https://github.com/google/fonts), at commit
`9710da1eacb3be272583c3224dcb70f9da6eadbb` (2026-09-30T09:54:00Z), from
`https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/<path>`.
Each family's licence file from the same directory is in `licenses/<File>-<LICENCE FILE>`. Every
family is under the SIL Open Font License 1.1 (`OFL.txt`) except Permanent Marker (Apache License
2.0, `LICENSE.txt`); both allow redistribution and embedding. Only upright (non-italic) files are
shipped; Google's repository no longer has static weights for variable families, so those are the
variable files (weights stay selectable for Shotstack).

| File | Family | Upstream path in google/fonts | Type | Licence | Bytes |
| --- | --- | --- | --- | --- | ---: |
| `Anton.ttf` | Anton | `ofl/anton/Anton-Regular.ttf` | static | OFL 1.1 | 170,812 |
| `BebasNeue.ttf` | Bebas Neue | `ofl/bebasneue/BebasNeue-Regular.ttf` | static | OFL 1.1 | 61,400 |
| `Caveat.ttf` | Caveat | `ofl/caveat/Caveat[wght].ttf` | variable wght 400–700 | OFL 1.1 | 403,648 |
| `DMSans.ttf` | DM Sans | `ofl/dmsans/DMSans[opsz,wght].ttf` | variable, **names modified** (see below) | OFL 1.1 | 240,428 |
| `Fraunces.ttf` | Fraunces | `ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf` | variable, **modified** (see below) | OFL 1.1 | 347,148 |
| `Inter.ttf` | Inter | `ofl/inter/Inter[opsz,wght].ttf` | variable wght 100–900 | OFL 1.1 | 876,576 |
| `Montserrat.ttf` | Montserrat | `ofl/montserrat/Montserrat[wght].ttf` | variable, **modified** (see below) | OFL 1.1 | 857,572 |
| `NotoSans.ttf` | Noto Sans | `ofl/notosans/NotoSans[wdth,wght].ttf` | variable wght 100–900 | OFL 1.1 | 2,049,096 |
| `NotoSansArabic.ttf` | Noto Sans Arabic | `ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf` | variable wght 100–900 | OFL 1.1 | 844,676 |
| `NotoSansDevanagari.ttf` | Noto Sans Devanagari | `ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf` | variable wght 100–900 | OFL 1.1 | 641,944 |
| `NotoSansSC.ttf` | Noto Sans SC | `ofl/notosanssc/NotoSansSC[wght].ttf` | variable, **modified** (see below) | OFL 1.1 | 17,753,052 |
| `PermanentMarker.ttf` | Permanent Marker | `apache/permanentmarker/PermanentMarker-Regular.ttf` | static | Apache 2.0 | 74,632 |
| `PlayfairDisplay.ttf` | Playfair Display | `ofl/playfairdisplay/PlayfairDisplay[wght].ttf` | variable wght 400–900 | OFL 1.1 | 300,724 |
| `Poppins.ttf` | Poppins | `ofl/poppins/Poppins-Regular.ttf` | static Regular only | OFL 1.1 | 160,316 |
| `RobotoMono.ttf` | Roboto Mono | `ofl/robotomono/RobotoMono[wght].ttf` | variable wght 100–700 | OFL 1.1 | 183,700 |
| `SpaceMono.ttf` | Space Mono | `ofl/spacemono/SpaceMono-Regular.ttf` | static Regular only | OFL 1.1 | 99,356 |

Total: 16 files, 25,065,080 bytes (about 24 MB; Noto Sans SC alone is 17.8 MB because it covers the
full Simplified Chinese character set).

## Modified files

Four upstream variable files default to a non-Regular instance or carry an instance name in their
family name (`Montserrat[wght].ttf` defaults to Thin and is named "Montserrat Thin";
`NotoSansSC[wght].ttf` defaults to Thin, "Noto Sans SC Thin"; `Fraunces[…].ttf` defaults to Black;
`DMSans[opsz,wght].ttf` is named "DM Sans 9pt"). FFmpeg would draw them Thin/Black and Shotstack
could fail to match the family, so they were rebuilt with
[`scripts/fonts/regular-default.py`](../../scripts/fonts/regular-default.py) (fontTools 4.60.1,
`fontTools.varLib.instancer`):

```sh
pip install fonttools==4.60.1
python scripts/fonts/regular-default.py Montserrat[wght].ttf public/fonts/Montserrat.ttf "Montserrat"
python scripts/fonts/regular-default.py NotoSansSC[wght].ttf public/fonts/NotoSansSC.ttf "Noto Sans SC"
python scripts/fonts/regular-default.py "Fraunces[SOFT,WONK,opsz,wght].ttf" public/fonts/Fraunces.ttf "Fraunces"
python scripts/fonts/regular-default.py "DMSans[opsz,wght].ttf" public/fonts/DMSans.ttf "DM Sans" --keep-weights
```

Montserrat, Noto Sans SC and Fraunces: the weight axis is limited to 400–900 with 400 as the new
default (the lighter weights are dropped); other axes are unchanged. All four: name IDs 1/2/4/6
set to the family / Regular, typographic names (16/17) removed, a modification note in name ID 10,
OS/2 weight class 400. These are Modified Versions under the SIL OFL 1.1 and stay under it; none of
the family names is a Reserved Font Name (Noto Sans SC reserves only "Source"). SHA-256 of the
upstream files before modification:

| Upstream file | SHA-256 |
| --- | --- |
| `Montserrat[wght].ttf` | `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7` |
| `NotoSansSC[wght].ttf` | `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` |
| `Fraunces[SOFT,WONK,opsz,wght].ttf` | `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb` |
| `DMSans[opsz,wght].ttf` | `8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d` |

## Adding a family

A brand kit can name any family (free text); a family that is not here fails the render. To add
one: download its TTF from google/fonts (`ofl/` or `apache/` only), save it as
`<FamilyWithoutSpaces>.ttf`, check its family name and default weight (the test does), copy its
licence to `licenses/` and add a row to the table above (the test reads the Family column and the
total size). Uploaded brand fonts need nothing: they are served from
storage by signed URL.
