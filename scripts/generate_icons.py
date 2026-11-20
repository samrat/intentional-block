#!/usr/bin/env python3
"""Generate crisp, anti-aliased PNG icons for Intentional Block using Python stdlib only."""

import math
import os
import struct
import zlib


def write_png(path, width, height, rgba_bytes):
    def chunk(tag, data):
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # Filter type 0 (None)
        raw.extend(rgba_bytes[y * stride : (y + 1) * stride])

    compressed = zlib.compress(bytes(raw), 9)
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", compressed))
        f.write(chunk(b"IEND", b""))


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def smoothstep(edge0, edge1, x):
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def sd_rounded_box(px, py, bx, by, r):
    qx = abs(px) - bx + r
    qy = abs(py) - by + r
    return (
        math.hypot(max(qx, 0.0), max(qy, 0.0))
        + min(max(qx, qy), 0.0)
        - r
    )


def render_icon(size):
    buf = bytearray(size * size * 4)
    aa = 1.6 / size  # anti-aliasing feather in normalized [-1, 1] space

    for y in range(size):
        for x in range(size):
            # Normalized coords in [-1, 1]
            nx = ((x + 0.5) / size) * 2.0 - 1.0
            ny = ((y + 0.5) / size) * 2.0 - 1.0

            # Outer rounded square background
            d_box = sd_rounded_box(nx, ny, 0.88, 0.88, 0.42)
            bg_alpha = 1.0 - smoothstep(-aa, aa, d_box)

            if bg_alpha <= 0.001:
                continue

            # Rich deep slate-to-indigo diagonal gradient
            grad = clamp((nx * 0.45 + ny * 0.55 + 1.0) * 0.5)
            r = 28 + grad * (78 - 28)
            g = 33 + grad * (82 - 33)
            b = 58 + grad * (186 - 58)

            # Subtle inner luminous glow at top-left
            glow = math.exp(-((nx + 0.35) ** 2 + (ny + 0.35) ** 2) * 1.9) * 0.25
            r = min(255, r + glow * 130)
            g = min(255, g + glow * 145)
            b = min(255, b + glow * 255)

            # Minimalist intentional focus emblem:
            # 1) Clean outer ring (representing calm boundary)
            dist = math.hypot(nx, ny)
            ring_d = abs(dist - 0.46) - 0.085
            ring_alpha = 1.0 - smoothstep(-aa, aa, ring_d)

            # 2) Center luminous dot (representing clear intention / focus)
            dot_d = dist - 0.17
            dot_alpha = 1.0 - smoothstep(-aa, aa, dot_d)

            # 3) Subtle vertical notch at top of ring (like a compass / power-of-intention mark)
            notch_d = sd_rounded_box(nx, ny + 0.46, 0.055, 0.12, 0.04)
            notch_cut = 1.0 - smoothstep(-aa, aa, notch_d)

            # Apply crisp white ring with top accent
            fg_alpha = clamp(ring_alpha * (1.0 - notch_cut * 0.75) + dot_alpha)

            # Ring is pure crisp off-white, center dot has a subtle emerald-cyan tint
            fg_r = 244 * (1.0 - dot_alpha) + 125 * dot_alpha
            fg_g = 246 * (1.0 - dot_alpha) + 240 * dot_alpha
            fg_b = 255 * (1.0 - dot_alpha) + 205 * dot_alpha

            out_r = r * (1.0 - fg_alpha) + fg_r * fg_alpha
            out_g = g * (1.0 - fg_alpha) + fg_g * fg_alpha
            out_b = b * (1.0 - fg_alpha) + fg_b * fg_alpha

            idx = (y * size + x) * 4
            buf[idx] = int(round(clamp(out_r, 0, 255)))
            buf[idx + 1] = int(round(clamp(out_g, 0, 255)))
            buf[idx + 2] = int(round(clamp(out_b, 0, 255)))
            buf[idx + 3] = int(round(clamp(bg_alpha * 255, 0, 255)))

    return bytes(buf)


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(base, "icons")
    for sz in (16, 32, 48, 128):
        out_path = os.path.join(icons_dir, f"icon{sz}.png")
        write_png(out_path, sz, sz, render_icon(sz))
        print(f"Generated {out_path}")


if __name__ == "__main__":
    main()
