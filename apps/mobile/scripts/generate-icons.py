"""从仓库根的 logo.png 生成 Android 应用图标（adaptive icon + 旧式 PNG）。

用法（仓库根目录）：python apps/mobile/scripts/generate-icons.py
依赖 Pillow。只在品牌图变化时需要重跑，产物已入库。

- 前景：logo 裁成圆形，外圈一道白边，整体直径 66dp，落在 adaptive icon 的安全区里——
  任何形状的遮罩（圆、方圆、水滴）都不会切到脸。
- 背景：drawable/ic_launcher_background.xml 的柔彩渐变（粉 → 淡紫 → 淡蓝，与桌面端画布的彩雾同色系）。
- 旧式 PNG：同样的前景叠在同样的渐变上，给不认 adaptive icon 的启动器用。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
RES = ROOT / "apps" / "mobile" / "android" / "app" / "src" / "main" / "res"
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
GRADIENT = [(0.0, (251, 207, 232)), (0.55, (233, 213, 255)), (1.0, (191, 219, 254))]
SUPERSAMPLE = 4


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            for (p0, c0), (p1, c1) in zip(GRADIENT, GRADIENT[1:]):
                if p0 <= t <= p1:
                    pixels[x, y] = lerp(c0, c1, (t - p0) / (p1 - p0))
                    break
    return image.convert("RGBA")


def medallion(logo, diameter_px):
    """圆形头像 + 白边 + 很淡的投影，返回 RGBA，边长 = diameter_px。"""
    big = diameter_px * SUPERSAMPLE
    ring = round(big * 0.045)
    inner = big - ring * 2
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    disc = Image.new("L", (big, big), 0)
    ImageDraw.Draw(disc).ellipse((0, 0, big - 1, big - 1), fill=255)
    canvas.paste(Image.new("RGBA", (big, big), (255, 255, 255, 255)), (0, 0), disc)
    face = logo.resize((inner, inner), Image.LANCZOS)
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, inner - 1, inner - 1), fill=255)
    canvas.paste(face, (ring, ring), mask)
    return canvas.resize((diameter_px, diameter_px), Image.LANCZOS)


def with_shadow(layer, canvas_size, offset_y):
    shadow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    alpha = layer.split()[3].point(lambda a: a * 0.22)
    tint = Image.new("RGBA", layer.size, (150, 80, 190, 255))
    tint.putalpha(alpha)
    pos = ((canvas_size - layer.width) // 2, (canvas_size - layer.height) // 2 + offset_y)
    shadow.alpha_composite(tint, pos)
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, canvas_size // 60)))
    shadow.alpha_composite(layer, ((canvas_size - layer.width) // 2, (canvas_size - layer.height) // 2))
    return shadow


def main():
    logo = Image.open(ROOT / "logo.png").convert("RGBA")
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(parents=True, exist_ok=True)
        # adaptive 前景：108dp 画布，徽章 66dp。
        fg_size = round(108 * scale)
        foreground = with_shadow(medallion(logo, round(66 * scale)), fg_size, round(1.5 * scale))
        foreground.save(folder / "ic_launcher_foreground.png", optimize=True)
        # 旧式图标：48dp，渐变底 + 40dp 徽章。
        legacy_size = round(48 * scale)
        legacy = gradient(legacy_size)
        badge = medallion(logo, round(40 * scale))
        legacy.alpha_composite(badge, ((legacy_size - badge.width) // 2, (legacy_size - badge.height) // 2))
        square = Image.new("L", (legacy_size, legacy_size), 0)
        ImageDraw.Draw(square).rounded_rectangle(
            (0, 0, legacy_size - 1, legacy_size - 1), radius=round(legacy_size * 0.22), fill=255
        )
        rounded = Image.new("RGBA", (legacy_size, legacy_size), (0, 0, 0, 0))
        rounded.paste(legacy, (0, 0), square)
        rounded.save(folder / "ic_launcher.png", optimize=True)
        circle = Image.new("L", (legacy_size, legacy_size), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, legacy_size - 1, legacy_size - 1), fill=255)
        round_icon = Image.new("RGBA", (legacy_size, legacy_size), (0, 0, 0, 0))
        round_icon.paste(legacy, (0, 0), circle)
        round_icon.save(folder / "ic_launcher_round.png", optimize=True)
    print("icons written to", RES)


if __name__ == "__main__":
    main()
