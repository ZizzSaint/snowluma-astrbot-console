"""把截图里的个人隐私区域打码（马赛克），用于公开分享。

覆盖内容：QQ 号 / 昵称 / 群名称与群消息（整个日志面板）、安全软件路径里的 Windows 用户名。
用法：python tools/redact-shots.py
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"

# 每个文件按比例给出需要打码的区域：(风格, x1, y1, x2, y2)，取值 0~1
# 风格：solid = 实心遮盖（彻底不可还原）；mosaic = 马赛克（适合大面积日志）
# 坐标是用 tools/grid-shot.py 叠加 2% 网格标尺量出来的，并留了足够余量
REGIONS = {
    "01-home.png": [
        ("solid", 0.585, 0.198, 1.0, 0.252),    # 桥接状态整行：QQ 登录 ZizzSaint (402226305)
        ("solid", 0.112, 0.655, 0.60, 0.722),   # SnowLuma 登录状态整行：已登录 …
    ],
    "02-snowluma.png": [
        ("solid", 0.228, 0.492, 0.62, 0.562),   # OneBot 连接：账号 ZizzSaint 402226305
    ],
    "03-astrbot.png": [
        ("solid", 0.0, 0.918, 0.21, 1.0),       # 左下角信息区（数据目录含 Windows 用户名）
    ],
    "04-bridge.png": [
        ("solid", 0.0, 0.918, 0.21, 1.0),       # 左下角信息区（数据目录含 Windows 用户名）
    ],
    "05-logs.png": [
        ("mosaic", 0.182, 0.132, 0.985, 0.928), # 整个日志面板（群名/昵称/QQ 号/消息内容）
        ("solid", 0.0, 0.918, 0.21, 1.0),       # 左下角信息区
    ],
}

BLOCK = 16          # 马赛克块大小（相对原图像素）
FILL = (22, 27, 34)  # 实心遮盖颜色（贴近应用深色背景）


def pixelate(img: Image.Image, box) -> None:
    x1, y1, x2, y2 = box
    region = img.crop(box)
    w, h = region.size
    if w < 2 or h < 2:
        return
    small = region.resize((max(1, w // BLOCK), max(1, h // BLOCK)), Image.BILINEAR)
    mosaic = small.resize((w, h), Image.NEAREST).filter(ImageFilter.GaussianBlur(1.4))
    img.paste(mosaic, (x1, y1))


def main() -> int:
    if not SHOTS.is_dir():
        print(f"找不到截图目录：{SHOTS}")
        return 1
    for name, regions in REGIONS.items():
        path = SHOTS / name
        if not path.exists():
            print(f"跳过（不存在）：{name}")
            continue
        with Image.open(path) as raw:
            img = raw.convert("RGB")
        w, h = img.size
        for style, x1, y1, x2, y2 in regions:
            box = (int(x1 * w), int(y1 * h), int(x2 * w), int(y2 * h))
            if style == "solid":
                ImageDraw.Draw(img).rectangle(box, fill=FILL)
            else:
                pixelate(img, box)
        img.save(path, optimize=True)
        print(f"已打码 {name}（{w}x{h}，{len(regions)} 处）→ {path.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
