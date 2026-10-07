"""给截图叠加百分比网格，方便精确圈定需要打码的区域。

用法：python tools/grid-shot.py docs/screenshots/01-home.png out.png [step]
"""
import sys

from PIL import Image, ImageDraw

src = sys.argv[1]
dst = sys.argv[2]
step = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0

img = Image.open(src).convert("RGB")
w, h = img.size
draw = ImageDraw.Draw(img)

i = 0.0
while i <= 100.0001:
    x = int(w * i / 100)
    y = int(h * i / 100)
    color = (255, 80, 80) if abs(i % 10) < 0.001 else (255, 200, 60)
    draw.line([(x, 0), (x, h)], fill=color, width=2 if abs(i % 10) < 0.001 else 1)
    draw.line([(0, y), (w, y)], fill=color, width=2 if abs(i % 10) < 0.001 else 1)
    if abs(i % 10) < 0.001:
        draw.text((x + 4, 6), f"{i:.0f}%", fill=(255, 80, 80))
        draw.text((6, y + 4), f"{i:.0f}%", fill=(255, 80, 80))
    i += step

img.save(dst)
print(f"网格图已生成：{dst}（{w}x{h}，步长 {step}%）")
