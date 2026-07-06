#!/usr/bin/env python3
"""
Generate iDotMatrix app icons / store images.
Updated to meet Homey App Store guidelines:
- App hero images have a solid, non-transparent background.
- Driver icons have a white background and unique design.
"""

import os
from PIL import Image, ImageDraw

BG = (24, 24, 28, 255)       # near-black
ACCENT = (255, 51, 102, 255) # brand red
DIM = (255, 51, 102, 70)     # dim LED
WHITE = (255, 255, 255, 255)


def draw_matrix(canvas, top_left, size, grid=16, on_pattern=None):
    """Draw a `grid x grid` pixel matrix occupying a `size x size` square
    starting at top_left."""
    x0, y0 = top_left
    cell = size / grid
    pad = max(1, cell * 0.15)
    for r in range(grid):
        for c in range(grid):
            x = x0 + c * cell + pad
            y = y0 + r * cell + pad
            w = cell - 2 * pad
            color = ACCENT if (c, r) in on_pattern else DIM
            canvas.ellipse([x, y, x + w, y + w], fill=color)


def heart_pattern(grid=16):
    """Compute lit pixels for a heart shape on a `grid x grid` matrix."""
    pattern = set()
    cx = grid / 2
    cy = grid / 2 - 0.5
    for r in range(grid):
        for c in range(grid):
            # Standard heart equation
            x = (c - cx) / (grid * 0.42)
            y = -(r - cy) / (grid * 0.42)
            v = (x * x + y * y - 1) ** 3 - x * x * y * y * y
            if v <= 0:
                pattern.add((c, r))
    return pattern


def grid_pattern(grid=16):
    """A simple 3x3 grid pattern for the driver icon."""
    on = set()
    # Draw a 3x3 grid in the middle
    start = grid // 4
    end = grid - start
    step = (end - start) // 2
    for r in range(start, end + 1, step):
        for c in range(start, end + 1, step):
            on.add((c, r))
    return on


def make_hero(width, height):
    """Wider hero image with a solid background filling the entire canvas."""
    img = Image.new('RGBA', (width, height), BG)  # Solid background
    draw = ImageDraw.Draw(img)

    # Matrix glyph on the left half
    glyph = int(height * 0.8)
    gx = int(width * 0.1)
    gy = (height - glyph) // 2
    draw_matrix(draw, (gx, gy), glyph, grid=16, on_pattern=heart_pattern(16))

    # Text placeholder "iDotMatrix" (simplified dots)
    # This makes the image "lively" and fills space
    mini = int(height * 0.3)
    mx = width - int(width * 0.1) - mini
    my = (height - mini) // 2
    draw_matrix(draw, (mx, my), mini, grid=8, on_pattern=grid_pattern(8))

    return img


def make_driver_icon(width, height):
    """Driver icon on a solid white background."""
    img = Image.new('RGBA', (width, height), WHITE)
    draw = ImageDraw.Draw(img)

    # Device frame
    pad = int(min(width, height) * 0.1)
    draw.rectangle([pad, pad, width - pad, height - pad], outline=ACCENT, width=int(min(width, height) * 0.05))

    # Matrix glyph inside
    glyph_size = int(min(width, height) * 0.6)
    x0 = (width - glyph_size) // 2
    y0 = (height - glyph_size) // 2
    draw_matrix(draw, (x0, y0), glyph_size, grid=8, on_pattern=grid_pattern(8))

    return img


def write(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    print(path, img.size, os.path.getsize(path), 'bytes')


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

    # App-level images: Solid background, filling canvas
    write(make_hero(250, 175), os.path.join(root, 'assets/images/small.png'))
    write(make_hero(500, 350), os.path.join(root, 'assets/images/large.png'))
    write(make_hero(1000, 700), os.path.join(root, 'assets/images/xlarge.png'))

    # Driver-level images: White background, unique design
    write(make_driver_icon(75, 75), os.path.join(root, 'drivers/idotmatrix/assets/images/small.png'))
    write(make_driver_icon(500, 500), os.path.join(root, 'drivers/idotmatrix/assets/images/large.png'))
    write(make_driver_icon(1000, 1000), os.path.join(root, 'drivers/idotmatrix/assets/images/xlarge.png'))


if __name__ == '__main__':
    main()
