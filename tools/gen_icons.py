#!/usr/bin/env python3
"""生成托盘图标组与应用图标。

托盘图标：assets/tray/{16,24,32}/ 下
  bat_000 ~ bat_100  正常（填充色随电量：>50 绿，21-50 橙，≤20 红）
  low_000 ~ low_100  低电量（红色边框 + 红色填充）
  disc               未连接（灰色 ×）
  idle               已连接但无电池运行（灰色空心）
应用图标：assets/icon.ico（多尺寸）
"""

import os
from PIL import Image, ImageDraw

BASE = os.path.join(os.path.dirname(__file__), "..", "assets", "tray")

GREEN = (67, 214, 117, 255)
AMBER = (245, 166, 35, 255)
RED = (255, 82, 82, 255)
BORDER = (232, 232, 232, 255)
GRAY = (130, 138, 155, 255)

SUPER = 4  # 超采样抗锯齿


def level_color(level):
    if level <= 20:
        return RED
    if level <= 50:
        return AMBER
    return GREEN


def draw_battery(size, level=None, fill=GREEN, border=BORDER, mode="normal"):
    """在 size×size 画布上画电池。level 为 0~100 或 None（空心）。"""
    S = size * SUPER
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def sc(v):
        return int(round(v * S / 16))

    # 电池体：x 1..13, y 4..12；极耳：x 13..15, y 6..10（16px 设计网格）
    x0, y0, x1, y1 = sc(1), sc(4), sc(13), sc(12)
    bw = max(sc(1), SUPER)  # 边框宽
    d.rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=sc(1.6), outline=border, width=bw)
    # 极耳
    d.rectangle([sc(13), sc(6.4), sc(15), sc(9.6)], fill=border)

    if level is not None:
        # 内部填充区域
        ix0, iy0, ix1, iy1 = x0 + bw + sc(0.4), y0 + bw + sc(0.4), x1 - bw - sc(0.4), y1 - bw - sc(0.4)
        w = (ix1 - ix0) * max(0, min(100, level)) // 100
        if level > 0:
            w = max(w, sc(1.2))
        if w > 0:
            d.rectangle([ix0, iy0, ix0 + w, iy1], fill=fill)

    if mode == "disc":
        # 灰色 × 覆盖
        lw = max(sc(1.1), SUPER)
        d.line([sc(3), sc(4.5), sc(13), sc(11.5)], fill=GRAY, width=lw)
        d.line([sc(13), sc(4.5), sc(3), sc(11.5)], fill=GRAY, width=lw)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in (16, 24, 32):
        out = os.path.join(BASE, str(size))
        os.makedirs(out, exist_ok=True)
        for level in range(0, 101, 10):
            draw_battery(size, level, level_color(level), BORDER).save(
                os.path.join(out, f"bat_{level:03d}.png"))
            draw_battery(size, level, RED, RED).save(
                os.path.join(out, f"low_{level:03d}.png"))
        draw_battery(size, None, GRAY, GRAY, "disc").save(os.path.join(out, "disc.png"))
        draw_battery(size, None, GRAY, GRAY).save(os.path.join(out, "idle.png"))

    # 应用图标（256px，电池 + 绿色填充）
    icon = draw_battery(256, 75, GREEN, BORDER)
    ico_path = os.path.join(os.path.dirname(__file__), "..", "assets", "icon.ico")
    icon.save(ico_path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("图标生成完成")


if __name__ == "__main__":
    main()
