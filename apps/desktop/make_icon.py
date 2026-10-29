# 生成 Suiji Ledger 图标 icon.ico（蓝色圆角方块 + 白色天平，与 Web 图标同形）
from PIL import Image, ImageDraw

S = 256
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 蓝色渐变圆角方块
r = 52
for y in range(S):
    t = y / S
    c = (int(59 + (47 - 59) * t), int(130 + (95 - 130) * t), int(246 + (208 - 246) * t), 255)
    d.line([(0, y), (S, y)], fill=c)
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
img.putalpha(mask)
d = ImageDraw.Draw(img)

W = (255, 255, 255, 255)
cx = S // 2

# 顶环
d.ellipse([cx - 26, 40, cx + 26, 92], outline=W, width=14)
# 中心柱
d.rectangle([cx - 11, 92, cx + 11, 200], fill=W)
# 横梁
d.rounded_rectangle([64, 118, S - 64, 142], radius=10, fill=W)
# 左吊绳 + 秤盘
d.polygon([(84, 146), (52, 208), (116, 208)], fill=W)
d.rounded_rectangle([42, 208, 126, 232], radius=9, fill=W)
# 右吊绳 + 秤盘
d.polygon([(S - 84, 146), (S - 116, 208), (S - 52, 208)], fill=W)
d.rounded_rectangle([S - 126, 208, S - 42, 232], radius=9, fill=W)
# 底座
d.rounded_rectangle([76, 214, S - 76, 240], radius=10, fill=W)

img.save('icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save('icon.png')
print('icon.ico generated')
