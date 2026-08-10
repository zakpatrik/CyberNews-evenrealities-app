#!/usr/bin/env python3
"""Prepare simulator captures for submission.

Three rejections are baked into this script, and the lesson of all three is the
same: leave the capture alone.

The framebuffer is pure green (R=0, G=255, B=0) with the artwork carried
entirely in the **alpha channel** — 95% of a typical frame is fully
transparent. That is not an artifact to be cleaned up, it is the display: the
G2 is additive, only the lit pixels emit, and the wearer sees the world behind
them. So:

  - Greyscale averages the RGB into a flat grey rectangle. The monochrome rule
    covers the icon and background artwork, not screenshots.
  - Flattening onto black submits a slab nobody ever sees.
  - Flattening onto grey is the same mistake in a lighter colour.

Hence the default is `none`: copy the capture through byte-for-byte, having
checked it really does carry transparency. The painted grounds remain for
places that need an opaque image — a README, a slide — never for submission.

    python3 scripts/make-shots.py [--bg none|slate|dusk|scene]

Python rather than Node because this needs to *decode* PNGs, and Pillow beats
hand-rolling an inflate/unfilter pass for a build-time script.
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
W, H = 576, 288


def slate(im, d):
    """Neutral grey wash. Nothing competes with the green."""
    for y in range(H):
        v = int(58 + 26 * y / H)
        d.line([(0, y), (W, y)], fill=(v - 4, v, v - 2))


def dusk(im, d):
    """Cool gradient. A little depth, contrast still even top to bottom."""
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(34 + 30 * t), int(42 + 34 * t), int(52 + 38 * t)))


def scene(im, d):
    """Stands in for a real view — truest to wearing them, hardest to read."""
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(96 - 30 * t), int(104 - 32 * t), int(112 - 34 * t)))
    for cx, cy, r, c in ((110, 210, 130, (70, 82, 92)),
                         (470, 90, 150, (126, 132, 138)),
                         (300, 260, 180, (60, 70, 80))):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return im.filter(ImageFilter.GaussianBlur(26))


BACKGROUNDS = {"slate": slate, "dusk": dusk, "scene": scene}


def build_background(kind):
    im = Image.new("RGB", (W, H))
    result = BACKGROUNDS[kind](im, ImageDraw.Draw(im))
    return (result or im).convert("RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bg", default="none", choices=["none", *sorted(BACKGROUNDS)],
                    help="none keeps the transparent background, which is what submission wants")
    ap.add_argument("--raw", default="docs/screenshots/raw")
    ap.add_argument("--out", default="docs/screenshots")
    args = ap.parse_args()

    # Absolute paths are honoured as given; relative ones hang off the repo.
    raw_dir = Path(args.raw) if Path(args.raw).is_absolute() else ROOT / args.raw
    out_dir = Path(args.out) if Path(args.out).is_absolute() else ROOT / args.out
    shots = sorted(raw_dir.glob("*.png"))
    if not shots:
        sys.exit(f"No captures in {raw_dir}. Take them with the simulator's "
                 f"/api/screenshot/glasses first.")

    out_dir.mkdir(parents=True, exist_ok=True)
    background = build_background(args.bg) if args.bg != "none" else None

    for shot in shots:
        src = Image.open(shot).convert("RGBA")
        if src.size != (W, H):
            sys.exit(f"{shot.name} is {src.size}, expected {(W, H)} — not a glasses capture.")

        alpha = src.getchannel("A")
        lit = sum(1 for a in alpha.getdata() if a > 0)
        dest = out_dir / shot.name

        if background is None:
            # A capture with no transparency is a sign it has already been
            # flattened somewhere upstream — exactly the thing that got rejected.
            if alpha.getextrema()[0] != 0:
                sys.exit(f"{shot.name} has no transparent pixels. Re-capture it from "
                         f"the simulator; do not pre-flatten.")
            dest.write_bytes(shot.read_bytes())
        else:
            Image.alpha_composite(background, src).convert("RGB").save(dest)

        try:
            shown = dest.relative_to(ROOT)
        except ValueError:
            shown = dest
        ground = "transparent" if background is None else args.bg
        print(f"  {shown}  {ground}  {lit} UI pixels "
              f"({lit / (W * H) * 100:.1f}% lit, {(W * H - lit) / (W * H) * 100:.1f}% see-through)")

    if background is None:
        print(f"\n{len(shots)} screenshots, transparent, copied unaltered from {args.raw}.")
    else:
        print(f"\n{len(shots)} screenshots on '{args.bg}'. NOT for submission — "
              f"an opaque ground was rejected twice.")


if __name__ == "__main__":
    main()
