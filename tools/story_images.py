#!/usr/bin/env python3
"""第 03／04 環節故事卡：由原始圖片產生網站用的 WebP（可重複執行）。

來源：使用者提供的「分類用故事卡」資料夾（8 張原始 PNG／JPG）。原始檔另存於 source-assets/stories/（不在網站上使用）。
輸出（assets/stories/）：
  story-NN.webp        閱讀圖：寬 1200（來源較窄時維持原寬，不放大），高度等比
  story-NN-600w.webp   看板縮圖：寬 600，高度等比
  NN＝Word 文件「小卡故事分類小卡_八部作品最新版.docx」中的作品編號（01～08）。
處理：不裁切、不拉伸（等比縮小，Lanczos）；不加文字；有損 WebP、method 6；來源沒有 ICC 與 EXIF 方向，輸出也不加。
另計算每張輸出與「同尺寸、未壓縮縮圖」之間的 PSNR，供檢查畫質。

用法：python3 -I tools/story_images.py <來源資料夾> [--quality 85] [--copy-originals]
"""
import argparse
import csv
import hashlib
import io
import math
import os
import shutil
import sys

from PIL import Image, ImageChops, ImageStat

# 作品編號、名稱、原始檔名（「動物方程市.png」為原檔名，網站名稱統一為「動物方城市」）
WORKS = [
    ('01', '神奇柑仔店', '神奇柑仔店.jpg'),
    ('02', '鬼滅之刃', '鬼滅之刃.png'),
    ('03', '國家寶藏', '國家寶藏.png'),
    ('04', '動物方城市', '動物方程市.png'),
    ('05', '北海小英雄', '北海小英雄.png'),
    ('06', '寶可夢', '寶可夢.jpg'),
    ('07', '功夫熊貓', '功夫熊貓.jpg'),
    ('08', '倚天屠龍記', '倚天屠龍記.png'),
]
SIZES = [('', 1200), ('-600w', 600)]
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]


def psnr(a, b):
    diff = ImageChops.difference(a.convert('RGB'), b.convert('RGB'))
    mse = sum(v ** 2 for v in ImageStat.Stat(diff).rms) / 3
    return 99.0 if mse == 0 else 10 * math.log10(255 ** 2 / mse)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--quality', type=int, default=85)
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'stories'))
    ap.add_argument('--manifest', default=os.path.join(ROOT, 'docs', 'story-assets.csv'))
    ap.add_argument('--copy-originals', action='store_true', help='把原始檔複製到 source-assets/stories/')
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    if a.copy_originals:
        os.makedirs(os.path.join(ROOT, 'source-assets', 'stories'), exist_ok=True)
    rows = []
    for no, title, fname in WORKS:
        src = os.path.join(a.src, fname)
        im = Image.open(src)
        if im.info.get('icc_profile') or im.getexif().get(274) not in (None, 1):
            sys.exit(f'{fname}: 含 ICC 設定檔或 EXIF 方向，請確認色彩／方向處理方式')
        im = im.convert('RGB')
        if a.copy_originals:
            shutil.copyfile(src, os.path.join(ROOT, 'source-assets', 'stories', fname))
        for suffix, width in SIZES:
            w = min(width, im.width)                       # 不放大
            h = round(im.height * w / im.width)
            ref = im if w == im.width else im.resize((w, h), Image.LANCZOS)
            name = f'story-{no}{suffix}.webp'
            dst = os.path.join(out, name)
            ref.save(dst, 'WEBP', quality=a.quality, method=6)
            back = Image.open(dst)
            rows.append([no, title, f'source-assets/stories/{fname}', f'{im.width}×{im.height}', os.path.getsize(src),
                         f'assets/stories/{name}', f'{back.width}×{back.height}', os.path.getsize(dst),
                         f'WebP 有損 q{a.quality} method 6、Lanczos 等比縮小', f'{psnr(ref, back):.1f}', sha(dst)])
            print(f'{no} {title} → {name} {back.width}×{back.height} {os.path.getsize(dst) // 1024} KB PSNR {rows[-1][-2]} dB')
    with open(a.manifest, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['作品編號', '作品', '原檔', '原檔尺寸', '原檔位元組', '輸出', '輸出尺寸', '輸出位元組', '壓縮設定', 'PSNR(dB，對同尺寸未壓縮圖)', 'SHA-256 前 16 碼'])
        w.writerows(rows)


if __name__ == '__main__':
    main()
