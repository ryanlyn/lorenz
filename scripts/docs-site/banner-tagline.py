#!/usr/bin/env python3
"""Rewrite the tagline on docs/images/lorenz-banner.png without touching the art.

The banner embeds docs/images/lorenz-logo.png (scale 968/620, offset 416,37,
per-channel affine grade fitted at corr .95-.98). This script erases whatever
text sits in the tagline band by refilling it with that graded art plus the
banner's smoothed scrim field, then draws TAGLINE_SEGS centered at the same
baseline. Edit TAGLINE_SEGS and rerun to change the copy.

Usage:
    pip install pillow numpy opencv-python-headless
    python3 scripts/docs-site/banner-tagline.py

Inter variable TTFs are downloaded next to this script on first run.
"""
import os
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..'))
BANNER = os.path.join(REPO, 'docs', 'images', 'lorenz-banner.png')
LOGO = os.path.join(REPO, 'docs', 'images', 'lorenz-logo.png')

# tagline copy: (text, style, color); style 'reg' or 'ital'
GRAY = (211, 210, 208, 255)
GREEN = (169, 220, 118, 255)
TAGLINE_SEGS = [
    ('Human-', 'reg', GRAY),
    ('on', 'ital', GREEN),
    ('-the-loop agents', 'reg', GRAY),
]

FONTS = {
    'Inter.ttf': 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf',
    'Inter-Italic.ttf': 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf',
}
for name, url in FONTS.items():
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        print('fetching', name)
        urllib.request.urlretrieve(url, path)

# how the attractor art is embedded in the banner (fitted against the original)
BG = np.array([27.0, 24.0, 28.0], np.float32)
GRADE = ((0.762, 2.6), (0.825, 7.9), (0.870, 6.2))
ART_W, ART_OX, ART_OY = 968, 416, 37
# tagline band (glyphs live in y 484..532); strip includes context for the fit
Y0, Y1, X0, X1 = 460, 560, 360, 1450
BAND = (484, 532, 405, 1395)
CX, BASELINE, SIZE = 900, 514, 28

orig_im = Image.open(BANNER)
logo = Image.open(LOGO)
orig = np.array(orig_im).astype(np.float32)
SH, SW = Y1 - Y0, X1 - X0

# graded art layer, restricted to the strip
s = ART_W / logo.width
lg = np.array(logo.resize((ART_W, int(round(logo.height * s))), Image.LANCZOS)).astype(np.float32)
al = lg[..., 3:4] / 255.0
graded = np.stack([lg[..., c] * k + b for c, (k, b) in enumerate(GRADE)], -1)
art_full = graded * al + BG * (1 - al)
art = np.empty((SH, SW, 3), np.float32)
art[:] = BG
lh, lw = art_full.shape[:2]
ix0, ix1 = max(X0, ART_OX), min(X1, ART_OX + lw)
iy0, iy1 = max(Y0, ART_OY), min(Y1, ART_OY + lh)
art[iy0 - Y0:iy1 - Y0, ix0 - X0:ix1 - X0] = art_full[iy0 - ART_OY:iy1 - ART_OY, ix0 - ART_OX:ix1 - ART_OX]

strip_o = orig[Y0:Y1, X0:X1, :3]

# current glyphs in the band (bright pixels), for the scrim-field inpaint
gmask = (strip_o.min(axis=2) > 75).astype(np.uint8) * 255
gmask = cv2.dilate(gmask, np.ones((5, 5), np.uint8), iterations=3)

# scrim field: banner minus art, inpainted under glyphs, smoothed
S = strip_o - art
Sf = np.empty_like(S)
for c in range(3):
    ch = np.clip(S[..., c] + 128.0, 0, 255).astype(np.uint8)
    filled = cv2.inpaint(ch, gmask, 5, cv2.INPAINT_TELEA).astype(np.float32) - 128.0
    Sf[..., c] = cv2.GaussianBlur(filled, (0, 0), 8)

# replace the whole band, feathered, so no glyph shadows survive
by0, by1, bx0, bx1 = BAND
band = np.zeros((SH, SW), np.float32)
band[by0 - Y0:by1 - Y0, bx0 - X0:bx1 - X0] = 1.0
w = cv2.GaussianBlur(band, (0, 0), 6)[..., None]
recon = np.clip(art + Sf, 0, 255)
blended = strip_o * (1 - w) + recon * w

out = orig.copy()
out[Y0:Y1, X0:X1, :3] = blended
img = Image.fromarray(out.astype(np.uint8))

# draw the tagline
def font(name, wght):
    f = ImageFont.truetype(os.path.join(HERE, name), SIZE)
    f.set_variation_by_axes([SIZE, wght])
    return f

styles = {'reg': font('Inter.ttf', 400), 'ital': font('Inter-Italic.ttf', 620)}
segs = [(t, styles[st], c) for t, st, c in TAGLINE_SEGS]

d = ImageDraw.Draw(img)
total = sum(d.textlength(t, font=f) for t, f, _ in segs)
x = CX - total / 2

shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sx = x
for t, f, _ in segs:
    sd.text((sx, BASELINE + 2), t, font=f, fill=(8, 9, 10, 190), anchor='ls')
    sx += sd.textlength(t, font=f)
shadow = shadow.filter(ImageFilter.GaussianBlur(3))
img = Image.alpha_composite(img, shadow)

d = ImageDraw.Draw(img)
for t, f, c in segs:
    d.text((x, BASELINE), t, font=f, fill=c, anchor='ls')
    x += d.textlength(t, font=f)

img.save(BANNER)
print('updated', os.path.relpath(BANNER, REPO))
