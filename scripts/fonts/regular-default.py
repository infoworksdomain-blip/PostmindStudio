"""Re-default a Google Fonts variable TTF to its Regular (400) instance.

BACKLOG 20.7 (public/fonts/SOURCES.md): FFmpeg drawtext (overlay pre-render, thumbnails) has no
variation-axis option, so it draws a variable font's DEFAULT instance. A few upstream files default
to Thin or Black and name their family after that instance (e.g. "Montserrat Thin"), so this moves
the default to wght 400, drops the weights below it, and names the family exactly as Studio asks
for it. Weights 400..900 stay variable.

    pip install fonttools==4.60.1
    python scripts/fonts/regular-default.py IN.ttf OUT.ttf "Family Name" [--keep-weights]

--keep-weights: the default is already Regular; only the names are fixed (e.g. "DM Sans 9pt").
"""

import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

NOTE = (
    "Modified by PostMind Studio from the Google Fonts release: default instance set to Regular "
    "(wght 400) and family renamed; licensed under the SIL Open Font License 1.1."
)


def main(src: str, dst: str, family: str, keep_weights: bool) -> None:
    font = TTFont(src)
    if not keep_weights:
        axes = {a.axisTag: a for a in font["fvar"].axes}
        top = axes["wght"].maxValue
        font = instancer.instantiateVariableFont(
            font, {"wght": instancer.AxisTriple(400, 400, top)}
        )
    name = font["name"]
    ps = family.replace(" ", "") + "-Regular"
    for rec_id in (16, 17, 21, 22):
        name.removeNames(nameID=rec_id)
    for platform in ((3, 1, 0x409), (1, 0, 0)):
        if not name.getName(1, *platform):
            continue
        name.setName(family, 1, *platform)
        name.setName("Regular", 2, *platform)
        name.setName(f"{family} Regular", 4, *platform)
        name.setName(ps, 6, *platform)
        name.setName(NOTE, 10, *platform)
    font["OS/2"].usWeightClass = 400
    # fsSelection: REGULAR (bit 6) only among ITALIC/BOLD/REGULAR; macStyle: not bold, not italic.
    font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0b1100001) | 0b1000000
    font["head"].macStyle = 0
    font.save(dst)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(args[0], args[1], args[2], "--keep-weights" in sys.argv)
