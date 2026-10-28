#!/usr/bin/env python3
"""
Generate the favicon's "BB" from Anton's real glyph outlines.

The wordmark on the site is set in Anton (--ts-font-display), so the
favicon's B's have to BE Anton's B's — not a hand-drawn letterform
that happens to look like one.

The outlines are baked into the SVG as paths rather than set as text in
a font, for two reasons:

  - an SVG loaded as an icon is an isolated document: it cannot use the
    page's webfonts, so <text font-family="Anton"> would silently fall
    back to Arial Narrow or Impact and the favicon would be a
    different letterform on every machine;
  - the icon is 1.6 KB of paths instead of 15 KB of embedded font.

The outlines are a SNAPSHOT of Anton as of 2026-10-28. If Anton is
ever updated, re-run this script.
"""
import re

from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen

FONT = "/tmp/Anton-Regular.ttf"
OUT = "/home/kyle/Development/specialists-browser/webxash/src/assets/brand/bb-favicon.svg"

VIEWBOX = 32
MARGIN = 2.38  # px of breathing room around the ink

font = TTFont(FONT)
glyph_set = font.getGlyphSet()
cmap = font.getBestCmap()

name = cmap[ord("B")]
pen = SVGPathPen(glyph_set)
glyph_set[name].draw(pen)
path = pen.getCommands()

advance = glyph_set[name].width
# The ink box of the B, from the glyph's own bounds.
bounds_pen = BoundsPen(glyph_set)
glyph_set[name].draw(bounds_pen)
x_min, y_min, x_max, y_max = bounds_pen.bounds
ink_w = x_max - x_min
ink_h = y_max - y_min

# Two B's, set on their advances the way the wordmark sets its letters.
span = advance + ink_w  # ink of the first to ink of the second

scale = (VIEWBOX - 2 * MARGIN) / ink_h
width = span * scale
tx = MARGIN + (VIEWBOX - 2 * MARGIN - width) / 2 - x_min * scale
ty = VIEWBOX - MARGIN

print(f"B ink: {ink_w} x {ink_h} units, advance {advance}")
print(f"scale {scale:.6f}, translate({tx:.4f} {ty:.4f})")
print(f"the two B's span {width:.2f}px of {VIEWBOX}")

second_x = advance * scale  # in px, inside the scaled group

svg = f"""<!--
  BulletBallet — the favicon.

  "BB", in the wordmark's two-tone: the first B in the ghost-white the
  wordmark's BULLET is drawn in, the second in the phosphor green
  BALLET is drawn in. On the void ground, so it holds its contrast in a
  dark tab and in a light one.

  THE B's ARE ANTON'S B's
  ========================
  The wordmark on the site is set in Anton, so the favicon's B's are
  Anton's B's — the outlines, converted from the font and baked into
  this file as paths.

  Not as <text font-family="Anton">: an SVG loaded as an icon is an
  isolated document and cannot use the page's webfonts, so it would
  silently fall back to Arial Narrow or Impact and the favicon would be
  a different letterform on every machine. And not as an embedded font
  either: this is 1.6 KB of paths instead of 15 KB of base64.

  The outlines are a snapshot of Anton as of 2026-10-28. If Anton is
  updated, re-run webxash/tools/make-favicon.py.

  WHY LETTERS AND NOT THE MARK
  =============================
  The mark is two slender cartridges with internal cutouts. At 16px the
  cutouts vanish and what is left is a pair of green blobs — which is
  what this file used to be, and what it read as.

  The counters are Anton's own, which are small at this size: a B is
  eight pixels wide at 16px and Anton's counters are a fraction of that.
  It is legible as a pair of letterforms, which is what a tab needs.
-->
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 {VIEWBOX} {VIEWBOX}"
  role="img"
  aria-label="BulletBallet"
>
  <rect width="{VIEWBOX}" height="{VIEWBOX}" fill="#010a04" />
  <g transform="translate({tx:.4f} {ty:.4f}) scale({scale:.7f} {-scale:.7f})">
    <path fill="#d8ffe2" d="{path}" />
    <path fill="#00ff41" d="{path}" transform="translate({advance} 0)" />
  </g>
</svg>
"""

# An XML comment may not contain "--". One does and the whole file stops
# parsing, which in a favicon means a broken image icon in the tab and
# nothing at all in CI. This script has now shipped that bug once.
for comment in re.findall(r"<!--(.*?)-->", svg, re.S):
    assert "--" not in comment, "an XML comment may not contain '--'"

with open(OUT, "w", encoding="utf-8") as f:
    f.write(svg)
print("wrote", OUT)
