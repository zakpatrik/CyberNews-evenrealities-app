#!/usr/bin/env python3
"""Composite raw simulator captures onto a submission background.

Two screenshot rejections are baked into this script.

The framebuffer is pure green (R=0, G=255, B=0) with the artwork carried
entirely in the **alpha channel**. So:

  - Converting to greyscale averages the RGB and yields a flat grey rectangle.
    The monochrome rule covers the icon and background artwork, not screenshots
    — a screenshot has to be accurate, and the display is green.
  - Flattening onto black looks right but was rejected too. Black is a
    simulator artifact: the G2 is additive and transparent, only the green
    pixels emit, and the wearer sees the world behind them.

So the raw captures are kept untouched in raw/, and the submission set is
generated from them. Changing the house style is one flag, not a re-shoot.

    python3 scripts/make-shots.py [--bg slate|dusk|scene] [--out docs/screenshots]

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
    ap.add_argument("--bg", default="slate", choices=sorted(BACKGROUNDS))
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
    background = build_background(args.bg)

    for shot in shots:
        src = Image.open(shot).convert("RGBA")
        if src.size != (W, H):
            sys.exit(f"{shot.name} is {src.size}, expected {(W, H)} — not a glasses capture.")

        flat = Image.alpha_composite(background, src).convert("RGB")
        dest = out_dir / shot.name
        flat.save(dest)

        # Count from the source alpha, not the composite. The backgrounds carry
        # their own green bias, so "greenest channel" would match every pixel.
        lit = sum(1 for a in src.getchannel("A").getdata() if a > 0)
        try:
            shown = dest.relative_to(ROOT)
        except ValueError:
            shown = dest
        print(f"  {shown}  {args.bg}  {lit} UI pixels "
              f"({lit / (W * H) * 100:.1f}% of the canvas)")

    print(f"\n{len(shots)} screenshots on '{args.bg}'. Raw captures untouched in {args.raw}.")


if __name__ == "__main__":
    main()
