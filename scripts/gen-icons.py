#!/usr/bin/env python3
"""
Generate iDotMatrix app icons / store images.

The app concept is a BLE-connected 32x32 LED pixel display, so the artwork
draws a small LED matrix glyph (heart + sparkle pattern) on a dark
background with the brand red (#FF3366) — readable both at thumbnail and
hero sizes.
"""

import os
from PIL import Image, ImageDraw

BG = (24, 24, 28, 255)       # near-black
ACCENT = (255, 51, 102, 255) # brand red
DIM = (255, 51, 102, 70)     # dim LED
WHITE = (255, 255, 255, 255)


def draw_matrix(canvas, top_left, size, grid=16, on_pattern=None):
    """Draw a `grid x grid` pixel matrix occupying a `size x size` square
    starting at top_left. `on_pattern` is a set of (col, row) tuples that
    should be lit accent; off pixels are dim accent dots."""
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


def sparkle_pattern(grid=16):
    """A small sparkle / star pattern."""
    cx, cy = grid // 2, grid // 2
    on = set()
    for r in range(grid):
        for c in range(grid):
            if c == cx or r == cy:
                if abs(c - cx) + abs(r - cy) <= grid // 2 - 2:
                    on.add((c, r))
            if abs(c - cx) == abs(r - cy) and abs(c - cx) <= grid // 3:
                on.add((c, r))
    return on


def make_icon(width, height, pattern=None, pad_factor=0.10):
    """Square or rectangular icon: dark rounded rect background + matrix glyph centered."""
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Rounded background fills 90% of the smaller dim, centered.
    pad = int(min(width, height) * pad_factor)
    radius = int(min(width, height) * 0.12)
    draw.rounded_rectangle([pad, pad, width - pad, height - pad], radius=radius, fill=BG)
    # Matrix glyph fills 70% of available space, centered.
    glyph_size = int(min(width, height) * 0.70)
    x0 = (width - glyph_size) // 2
    y0 = (height - glyph_size) // 2
    grid = 16
    if pattern is None:
        pattern = heart_pattern(grid)
    draw_matrix(draw, (x0, y0), glyph_size, grid=grid, on_pattern=pattern)
    return img


def make_hero(width, height):
    """Wider hero image with matrix on the left and brand text mark on the right."""
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = int(height * 0.06)
    radius = int(height * 0.06)
    draw.rounded_rectangle([pad, pad, width - pad, height - pad], radius=radius, fill=BG)
    # Matrix glyph on the left half
    glyph = int(height * 0.78)
    gx = pad * 3
    gy = (height - glyph) // 2
    draw_matrix(draw, (gx, gy), glyph, grid=16, on_pattern=heart_pattern(16))
    # Mini-matrix accent on the right (sparkle)
    mini = int(height * 0.30)
    mx = width - pad * 3 - mini
    my = pad * 3
    draw_matrix(draw, (mx, my), mini, grid=8, on_pattern={
        (3, 0), (4, 0), (3, 1), (4, 1),
        (1, 3), (2, 3), (5, 3), (6, 3),
        (1, 4), (2, 4), (5, 4), (6, 4),
        (3, 6), (4, 6), (3, 7), (4, 7),
    })
    # Dotted "scroll" line of red dots beneath the mini-matrix
    line_y = my + mini + int(height * 0.10)
    dot_r = int(height * 0.025)
    spacing = int(height * 0.08)
    x = mx
    for _ in range(8):
        draw.ellipse([x, line_y, x + dot_r * 2, line_y + dot_r * 2], fill=DIM)
        x += spacing
    return img


def write(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    print(path, img.size, os.path.getsize(path), 'bytes')


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

    # App-level images per Homey App Store spec
    write(make_hero(250, 175), os.path.join(root, 'assets/images/small.png'))
    write(make_hero(500, 350), os.path.join(root, 'assets/images/large.png'))
    write(make_hero(1000, 700), os.path.join(root, 'assets/images/xlarge.png'))

    # Driver-level images
    write(make_icon(75, 75), os.path.join(root, 'drivers/idotmatrix/assets/images/small.png'))
    write(make_icon(500, 500), os.path.join(root, 'drivers/idotmatrix/assets/images/large.png'))
    write(make_icon(1000, 1000), os.path.join(root, 'drivers/idotmatrix/assets/images/xlarge.png'))


if __name__ == '__main__':
    main()
