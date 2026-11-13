#!/usr/bin/env python3
"""小說類型圖卡：產生網站用的 WebP（可重複執行）。

來源：使用者提供的「小說類型圖卡_WebP」資料夾（已由來源 PNG 轉成 WebP，品質 82、原始尺寸、sRGB；
      對應見該資料夾的「素材清單.csv」）。本工具不讀取也不需要 PNG。
輸出（assets/genres/）：
  <slug>-portrait.webp        直式主圖 1086×1448：與來源**逐位元組相同**（不重新壓縮，避免二次失真）
  <slug>-landscape.webp       橫式主圖 1672×941：同上
  <slug>-portrait-600w.webp   直式小圖：寬 600，高度等比
  <slug>-landscape-960w.webp  橫式小圖：寬 960，高度等比
小圖由主圖（WebP）縮小後以有損 WebP 編碼（Lanczos、method 6）。來源沒有內嵌 ICC（已是 sRGB），輸出也不加。

用法：python3 -I tools/genre_images.py <來源資料夾> [--quality 82]
"""
import argparse
import csv
import hashlib
import io
import os
import shutil
import sys

from PIL import Image

SLUGS = ['fantasy', 'detective', 'historical', 'adventure', 'wuxia']
SMALL = {'portrait': 600, 'landscape': 960}
EXPECT = {'portrait': (1086, 1448), 'landscape': (1672, 941)}
SRC_NAME = {  # 使用者原始 PNG 檔名（只用於記錄對應）
    'fantasy': '奇幻類型', 'detective': '推理類型', 'historical': '歷史類型', 'adventure': '冒險類型', 'wuxia': '武俠類型'}
RATIO_NAME = {'portrait': '3：4', 'landscape': '16：9'}


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--quality', type=int, default=82)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'genres'))
    ap.add_argument('--manifest', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'genre-assets.csv'))
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    rows = []
    for slug in SLUGS:
        for kind in ('portrait', 'landscape'):
            name = f'{slug}-{kind}.webp'
            src = os.path.join(a.src, name)
            im = Image.open(src)
            if im.format != 'WEBP' or im.size != EXPECT[kind]:
                sys.exit(f'{name}: 格式或尺寸不符（{im.format} {im.size}）')
            if im.info.get('icc_profile'):
                sys.exit(f'{name}: 含 ICC 設定檔，請確認色彩處理方式')
            dst = os.path.join(out, name)
            shutil.copyfile(src, dst)                       # 主圖：原檔
            rows.append([f'{SRC_NAME[slug]}{RATIO_NAME[kind]}.png', name, f'assets/genres/{name}', *im.size,
                         '來源 WebP（品質 82，未重新壓縮）', os.path.getsize(dst), sha(dst)])
            w = SMALL[kind]
            h = round(im.size[1] * w / im.size[0])
            small = im.convert('RGB').resize((w, h), Image.LANCZOS)
            sname = f'{slug}-{kind}-{w}w.webp'
            buf = io.BytesIO()
            small.save(buf, 'WEBP', quality=a.quality, method=6)
            open(os.path.join(out, sname), 'wb').write(buf.getvalue())
            rows.append([f'{SRC_NAME[slug]}{RATIO_NAME[kind]}.png', sname, f'assets/genres/{sname}', w, h,
                         f'由 {name} 縮小，WebP 有損 quality={a.quality} method=6', len(buf.getvalue()), sha(os.path.join(out, sname))])
    with open(os.path.abspath(a.manifest), 'w', newline='', encoding='utf-8') as f:
        wr = csv.writer(f)
        wr.writerow(['原始檔名', '輸出檔名', '網站路徑', '寬', '高', '處理', '位元組', 'sha256 前 16 碼'])
        wr.writerows(rows)
    for r in rows:
        print(f'{r[1]:34} {r[3]:>5}×{r[4]:<5} {r[6]:>8} B  {r[5]}')


if __name__ == '__main__':
    main()
