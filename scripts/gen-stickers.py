#!/usr/bin/env python3
"""
Generate a small starter pack of 32x32 stickers bundled with the app.
Animated GIFs use a few frames so they look alive on the display.
"""

import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageSequence

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'assets', 'stickers'))
os.makedirs(OUT, exist_ok=True)


def heart(frame, size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2 - 1
    scale = 0.42 + 0.08 * math.sin(frame * math.pi / 4)
    for y in range(size):
        for x in range(size):
            xn = (x - cx) / (size * scale)
            yn = -(y - cy) / (size * scale)
            v = (xn * xn + yn * yn - 1) ** 3 - xn * xn * yn ** 3
            if v <= 0:
                d.point((x, y), fill=(255, 51, 102))
    return img


def smile(size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, size - 3, size - 3], fill=(255, 215, 0), outline=(255, 165, 0))
    d.ellipse([10, 11, 13, 14], fill='black')
    d.ellipse([19, 11, 22, 14], fill='black')
    d.arc([8, 14, 24, 26], 0, 180, fill='black', width=2)
    return img


def fire_frame(t, size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    palette = [(255, 240, 100), (255, 180, 0), (255, 90, 0), (200, 30, 0)]
    for y in range(size):
        for x in range(size):
            cx = size / 2
            dy = size - y
            dx = abs(x - cx)
            n = math.sin(x * 0.6 + t * 1.3) * 2 + math.cos(y * 0.4 - t) * 1.5
            radius = dy * 0.45 + n
            if dx < radius and dy > 2:
                idx = min(len(palette) - 1, int(dx / max(1, radius) * len(palette)))
                d.point((x, y), fill=palette[idx])
    return img


def check(size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, size - 3, size - 3], fill=(0, 180, 0))
    d.line([8, 16, 14, 22], fill='white', width=3)
    d.line([14, 22, 24, 10], fill='white', width=3)
    return img


def cross(size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, size - 3, size - 3], fill=(200, 20, 20))
    d.line([10, 10, 22, 22], fill='white', width=3)
    d.line([22, 10, 10, 22], fill='white', width=3)
    return img


def arrow(size=32, direction='right'):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    color = (60, 180, 255)
    if direction == 'right':
        d.polygon([(4, 12), (18, 12), (18, 6), (28, 16), (18, 26), (18, 20), (4, 20)], fill=color)
    else:
        d.polygon([(28, 12), (14, 12), (14, 6), (4, 16), (14, 26), (14, 20), (28, 20)], fill=color)
    return img


def warning(size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    d.polygon([(16, 3), (29, 28), (3, 28)], fill=(255, 200, 0), outline=(120, 80, 0))
    d.rectangle([14, 10, 18, 21], fill='black')
    d.rectangle([14, 23, 18, 26], fill='black')
    return img


def rainbow_text(size=32):
    img = Image.new('RGB', (size, size), 'black')
    d = ImageDraw.Draw(img)
    for y in range(size):
        h = y / size
        r = int(255 * (math.sin(h * 6.28 + 0) * 0.5 + 0.5))
        g = int(255 * (math.sin(h * 6.28 + 2.1) * 0.5 + 0.5))
        b = int(255 * (math.sin(h * 6.28 + 4.2) * 0.5 + 0.5))
        d.line([(0, y), (size, y)], fill=(r, g, b))
    return img


def write_gif(name, frames, duration_ms=120):
    path = os.path.join(OUT, name)
    frames[0].save(
        path,
        format='GIF',
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
        optimize=True,
    )
    print(name, os.path.getsize(path), 'B,', len(frames), 'frames')


def write_png(name, img):
    path = os.path.join(OUT, name)
    img.save(path, format='PNG', optimize=True)
    print(name, os.path.getsize(path), 'B')


def main():
    write_gif('heart-beat.gif', [heart(i) for i in range(8)], 100)
    write_gif('fire.gif', [fire_frame(t / 2) for t in range(8)], 100)
    write_png('smile.png', smile())
    write_png('check.png', check())
    write_png('cross.png', cross())
    write_png('arrow-right.png', arrow(direction='right'))
    write_png('arrow-left.png', arrow(direction='left'))
    write_png('warning.png', warning())
    write_png('rainbow.png', rainbow_text())


if __name__ == '__main__':
    main()
