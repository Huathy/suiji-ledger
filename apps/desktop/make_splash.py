# 生成 portable 启动画面 splash.png（electron-builder portable.splashImage 用）
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
icon = Image.open(os.path.join(HERE, "icon.png")).convert("RGBA")

W, H = 400, 250
img = Image.new("RGB", (W, H), (18, 19, 24))  # 与 main.js backgroundColor #121318 一致
# 居中贴 icon（缩到 96）
ic = icon.resize((96, 96), Image.LANCZOS)
img.paste(ic, ((W - 96) // 2, 58), ic)

d = ImageDraw.Draw(img)
def ctext(y, text, size, fill):
    f = None
    for fp in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"):
        try:
            f = ImageFont.truetype(fp, size)
            break
        except Exception:
            continue
    if f is None:
        f = ImageFont.load_default()
    bb = d.textbbox((0, 0), text, font=f)
    d.text(((W - (bb[2] - bb[0])) // 2 - bb[0], y), text, font=f, fill=fill)

ctext(172, "Suiji Ledger", 22, (235, 237, 242))
ctext(206, "正在启动…解压运行时约需 1 分钟，请稍候", 12, (150, 155, 165))

out = os.path.join(HERE, "splash.png")
img.save(out)
print("saved", out, os.path.getsize(out), "bytes")
