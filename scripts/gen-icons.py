#!/usr/bin/env python3
"""
Generate iDotMatrix app icons / store images.
Meets Homey App Store guidelines:
- App hero images have a solid, non-transparent background and show the
  displays "in action" (colorful artwork, music visualizer, pixel text).
- Driver icons have a white background and unique design.
"""

import os
import colorsys
from PIL import Image, ImageDraw, ImageFilter

ACCENT = (255, 51, 102, 255)  # brand red
WHITE = (255, 255, 255, 255)

# ---------------------------------------------------------------------------
# Pixel-art content shown on the simulated displays
# ---------------------------------------------------------------------------


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def hsv(h, s, v):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def synthwave_pattern(grid=32):
    """Retro sunset artwork: banded sun over water, gradient sky, stars."""
    px = {}
    horizon = int(grid * 0.62)

    # Sky gradient: deep violet -> magenta -> orange
    top, mid, bot = (30, 6, 74), (150, 24, 130), (255, 96, 60)
    for r in range(horizon):
        t = r / max(1, horizon - 1)
        col = lerp(top, mid, t * 2) if t < 0.5 else lerp(mid, bot, (t - 0.5) * 2)
        for c in range(grid):
            px[(c, r)] = col

    # A few stars high in the sky
    for c, r in [(3, 2), (8, 4), (27, 3), (22, 1), (30, 6), (5, 7), (12, 1), (18, 4)]:
        if r < horizon - 8 and (c < grid // 2 - 7 or c > grid // 2 + 7):
            px[(c, r)] = (255, 244, 255)

    # Banded sun sitting on the horizon
    scx, scy, srad = grid / 2, horizon - 1.5, grid * 0.30
    for r in range(horizon):
        for c in range(grid):
            dx, dy = c - scx + 0.5, r - scy + 0.5
            if dx * dx + dy * dy <= srad * srad:
                t = max(0.0, min(1.0, (r - (scy - srad)) / (2 * srad)))
                # Classic horizontal cuts in the lower half of the sun
                if r >= scy - 1 and (r - int(scy)) % 2 == 1:
                    continue
                px[(c, r)] = lerp((255, 236, 120), (255, 64, 128), t)

    # Water with warm reflection streaks
    for r in range(horizon, grid):
        for c in range(grid):
            px[(c, r)] = (12, 8, 44)
    streaks = [
        (horizon + 1, 8, -3, (255, 96, 110)),
        (horizon + 3, 12, 2, (255, 82, 122)),
        (horizon + 5, 7, -2, (232, 64, 128)),
        (horizon + 7, 10, 3, (190, 52, 130)),
        (horizon + 9, 5, -2, (150, 40, 124)),
        (horizon + 11, 8, 1, (110, 32, 110)),
    ]
    for row, width, shift, col in streaks:
        if row >= grid:
            continue
        start = int(scx - width / 2) + shift
        for c in range(start, start + width):
            if 0 <= c < grid:
                px[(c, row)] = col
    return px


def equalizer_pattern(grid=16):
    """Rainbow music-sync bars with bright caps."""
    heights = [6, 10, 14, 8, 12, 15, 9, 5]
    px = {}
    for b, hgt in enumerate(heights):
        base = hsv(b / len(heights), 0.95, 0.95)
        for i in range(hgt):
            row = grid - 1 - i
            col = (250, 250, 255) if i == hgt - 1 else lerp(
                tuple(int(v * 0.55) for v in base), base, i / max(1, hgt - 1))
            for cc in (b * 2, b * 2 + 1):
                px[(cc, row)] = col
    return px


FONT_5X7 = {
    'H': ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    'I': ["111", "010", "010", "010", "010", "010", "111"],
}

HEART_7X6 = [
    "0110110",
    "1111111",
    "1111111",
    "0111110",
    "0011100",
    "0001000",
]


def text_heart_pattern(grid=16):
    """'HI' in a rainbow gradient with a beating heart below."""
    px = {}
    text = "HI"
    glyphs = [FONT_5X7[ch] for ch in text]
    width = sum(len(g[0]) for g in glyphs) + (len(glyphs) - 1)
    x = (grid - width) // 2
    for g in glyphs:
        for r, rowbits in enumerate(g):
            for c, bit in enumerate(rowbits):
                if bit == '1':
                    px[(x + c, 1 + r)] = hsv(0.5 + (x + c) / grid * 0.35, 0.85, 1.0)
        x += len(g[0]) + 1
    hx = (grid - len(HEART_7X6[0])) // 2
    for r, rowbits in enumerate(HEART_7X6):
        for c, bit in enumerate(rowbits):
            if bit == '1':
                px[(hx + c, 9 + r)] = (255, 51, 102)
    return px


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_panel(size, grid, pattern, corner_ratio=0.09, bezel_ratio=0.055):
    """Render one iDotMatrix display: dark bezel, LED grid, glow."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    corner = int(size * corner_ratio)

    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=corner,
                        fill=(16, 16, 22, 255), outline=(52, 52, 66, 255),
                        width=max(1, size // 250))

    bezel = int(size * bezel_ratio)
    inner = size - 2 * bezel
    cell = inner / grid
    pad = cell * 0.14

    leds = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    dl = ImageDraw.Draw(leds)
    for r in range(grid):
        for c in range(grid):
            x = bezel + c * cell + pad
            y = bezel + r * cell + pad
            w = cell - 2 * pad
            col = pattern.get((c, r))
            if col is None:
                d.rounded_rectangle([x, y, x + w, y + w], radius=w * 0.3,
                                    fill=(36, 36, 46, 255))
            else:
                dl.rounded_rectangle([x, y, x + w, y + w], radius=w * 0.3,
                                     fill=col + (255,))

    # Soft LED glow underneath the crisp pixels
    glow = leds.filter(ImageFilter.GaussianBlur(cell * 0.75))
    img.alpha_composite(glow)
    img.alpha_composite(glow)
    img.alpha_composite(leds)
    return img


def paste_rotated(canvas, panel, center, angle):
    """Paste a panel rotated by `angle` degrees with a soft drop shadow."""
    rotated = panel.rotate(angle, expand=True, resample=Image.BICUBIC)
    alpha = rotated.getchannel('A')
    shadow = Image.new('RGBA', rotated.size, (0, 0, 0, 0))
    shadow.putalpha(alpha.point(lambda a: a * 160 // 255))
    shadow = shadow.filter(ImageFilter.GaussianBlur(rotated.width * 0.02))
    off = int(rotated.width * 0.015)
    x = center[0] - rotated.width // 2
    y = center[1] - rotated.height // 2
    canvas.alpha_composite(shadow, (x + off, y + off * 2))
    canvas.alpha_composite(rotated, (x, y))


def make_hero(width, height):
    """Hero image: three displays in action on a dark ambient background."""
    scale = 2  # supersample for crisp downscaling
    W, H = width * scale, height * scale
    img = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    d = ImageDraw.Draw(img)

    # Vertical background gradient
    top, bot = (13, 12, 22), (30, 18, 48)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(top, bot, y / H))

    # Ambient color pools behind the panels
    ambient = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    da = ImageDraw.Draw(ambient)
    da.ellipse([W * 0.05, H * 0.10, W * 0.62, H * 0.95], fill=(255, 70, 120, 60))
    da.ellipse([W * 0.58, H * 0.02, W * 0.98, H * 0.50], fill=(60, 190, 255, 45))
    da.ellipse([W * 0.60, H * 0.52, W * 0.98, H * 0.98], fill=(150, 80, 255, 45))
    ambient = ambient.filter(ImageFilter.GaussianBlur(W * 0.06))
    img.alpha_composite(ambient)

    # Displays in action
    main = render_panel(int(H * 0.72), 32, synthwave_pattern(32))
    eq = render_panel(int(H * 0.40), 16, equalizer_pattern(16))
    txt = render_panel(int(H * 0.40), 16, text_heart_pattern(16))

    paste_rotated(img, main, (int(W * 0.335), int(H * 0.50)), -3.5)
    paste_rotated(img, eq, (int(W * 0.765), int(H * 0.285)), 5)
    paste_rotated(img, txt, (int(W * 0.72), int(H * 0.735)), -5)

    img = img.resize((width, height), Image.LANCZOS)
    return img.convert('RGB')


HEART_7X6_FULL = [
    "0110110",
    "1111111",
    "1111111",
    "0111110",
    "0011100",
    "0001000",
]


def heart_screen_pattern(grid=16):
    """Filled pixel-art heart (2x-scaled 7x6 bitmap) as screen content."""
    px = {}
    for r, rowbits in enumerate(HEART_7X6_FULL):
        col = lerp((255, 120, 150), (255, 40, 100), r / (len(HEART_7X6_FULL) - 1))
        for c, bit in enumerate(rowbits):
            if bit == '1':
                for dr in (0, 1):
                    for dc in (0, 1):
                        px[(1 + c * 2 + dc, 2 + r * 2 + dr)] = col
    return px


def make_driver_image(size):
    """Driver image: the display panel showing a heart, on solid white."""
    scale = 4 if size <= 100 else 2
    S = size * scale
    img = Image.new('RGBA', (S, S), WHITE)

    panel_size = int(S * 0.76)
    x = (S - panel_size) // 2
    y = (S - panel_size) // 2

    # Soft drop shadow so the panel reads as a physical device
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ds = ImageDraw.Draw(shadow)
    off = int(S * 0.015)
    ds.rounded_rectangle([x + off, y + off * 2, x + panel_size + off,
                          y + panel_size + off * 2],
                         radius=int(panel_size * 0.09), fill=(0, 0, 0, 70))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(S * 0.02)))

    panel = render_panel(panel_size, 16, heart_screen_pattern(16))
    img.alpha_composite(panel, (x, y))

    return img.resize((size, size), Image.LANCZOS).convert('RGB')


def write(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    print(path, img.size, os.path.getsize(path), 'bytes')


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

    # App-level images: displays in action on a solid background
    write(make_hero(250, 175), os.path.join(root, 'assets/images/small.png'))
    write(make_hero(500, 350), os.path.join(root, 'assets/images/large.png'))
    write(make_hero(1000, 700), os.path.join(root, 'assets/images/xlarge.png'))

    # Driver-level images: the device on a white background
    write(make_driver_image(75), os.path.join(root, 'drivers/idotmatrix/assets/images/small.png'))
    write(make_driver_image(500), os.path.join(root, 'drivers/idotmatrix/assets/images/large.png'))
    write(make_driver_image(1000), os.path.join(root, 'drivers/idotmatrix/assets/images/xlarge.png'))


if __name__ == '__main__':
    main()
