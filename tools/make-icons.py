#!/usr/bin/env python3
"""표 따오기 아이콘 생성기 — 표(그리드) 모티프, 표준 라이브러리만 사용."""
import os
import struct
import zlib

ACCENT = (255, 90, 43)
WHITE = (255, 255, 255)
CELL = (255, 255, 255, 38)  # 낮은 알파의 흰색 셀
SS = 4


def rounded(px, py, w, h, r):
    cx = min(max(px, r), w - r)
    cy = min(max(py, r), h - r)
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy <= r * r


def render(size):
    W = H = size * SS
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    radius = W * 0.23
    # 표 영역(여백 포함)
    tx, ty = W * 0.20, W * 0.22
    tw, th = W * 0.60, W * 0.56
    head_h = th * 0.30
    cols, rows = 3, 3
    gap = max(0.6, W * 0.018)
    cw = (tw - gap * (cols - 1)) / cols
    ch = (th - head_h - gap * (rows - 1)) / rows

    for sy in range(H):
        for sx in range(W):
            px, py = sx + 0.5, sy + 0.5
            if not rounded(px, py, W, H, radius):
                continue
            color = (255, 90, 43, 255)
            # 헤더 밴드
            if tx <= px <= tx + tw and ty <= py <= ty + head_h:
                color = WHITE + (255,)
            else:
                # 셀 격자
                for r in range(rows):
                    cy0 = ty + head_h + gap + r * (ch + gap)
                    if cy0 <= py <= cy0 + ch:
                        for c in range(cols):
                            cx0 = tx + c * (cw + gap)
                            if cx0 <= px <= cx0 + cw:
                                color = CELL
                                break
                        break
            idx = (sy // SS) * size + (sx // SS)
            cell = acc[idx]
            cell[0] += color[0]
            cell[1] += color[1]
            cell[2] += color[2]
            cell[3] += 255.0

    n = SS * SS
    out = bytearray()
    for i in range(size * size):
        r, g, b, a = acc[i]
        alpha = a / n
        if alpha <= 0.5:
            out += bytes((0, 0, 0, 0))
            continue
        out += bytes((
            int(round(min(255, r / n))),
            int(round(min(255, g / n))),
            int(round(min(255, b / n))),
            int(round(alpha)),
        ))
    return bytes(out)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, '..', 'extension', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f'icon-{size}.png')
        write_png(path, size, render(size))
        print(path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
