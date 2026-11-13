#!/usr/bin/env python3
"""第 03／04 環節故事卡：從 Word 原稿抽出正式文字（不改寫、不摘要）。

來源：source-assets/stories/小卡故事分類小卡_八部作品最新版.docx
規則（依原稿結構，不依段落樣式猜測內容）：
  * 「NN  《作品》」（CardTitle 樣式）開始一張卡；編號與書名號內的作品名稱分開取出。
  * 「故事介紹」與「值得留意的故事元素」兩個標籤之間的每個非空段落＝一段故事介紹（逐字保留，含原稿的空白與標點）。
    05《北海小英雄》的介紹段落在原稿中套用了標籤樣式，並以一個空段落分隔，這裡依位置判斷，仍視為兩段介紹。
  * 「值得留意的故事元素」之後的第一個非空段落，以全形斜線「／」分成元素。
輸出 JSON：[{no, title, paragraphs:[...], elements:[...]}]（8 筆，依原稿順序）。

用法：python3 -I tools/story_text.py [docx] [--json 輸出檔] [--sql 輸出檔]
  --sql：產生 supabase/content/story_cards_v1.sql 使用的 VALUES 區塊（供檢查；正式腳本內的文字由此產生）。
"""
import argparse
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DOCX = os.path.join(ROOT, 'source-assets', 'stories', '小卡故事分類小卡_八部作品最新版.docx')
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
SLUGS = ['story-a', 'story-b', 'story-c', 'story-d', 'story-e', 'story-f', 'story-g', 'story-h']


def paragraphs(path):
    root = ET.fromstring(zipfile.ZipFile(path).read('word/document.xml'))
    for p in root.iter(W + 'p'):
        yield ''.join(t.text or '' for t in p.iter(W + 't'))


def extract(path=DOCX):
    cards, cur, mode = [], None, None
    for text in paragraphs(path):
        m = re.fullmatch(r'(\d{2})\s+《(.+)》', text.strip())
        if m:
            cur = {'no': m.group(1), 'title': m.group(2), 'paragraphs': [], 'elements': []}
            cards.append(cur); mode = None
            continue
        if cur is None:
            continue
        if text.strip() == '故事介紹':
            mode = 'intro'; continue
        if text.strip() == '值得留意的故事元素':
            mode = 'elements'; continue
        if not text.strip():
            continue
        if mode == 'intro':
            cur['paragraphs'].append(text)
        elif mode == 'elements' and not cur['elements']:
            cur['elements'] = text.strip().split('／')
            mode = None
    return cards


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def sql_values(cards):
    rows = []
    for slug, c in zip(SLUGS, cards):
        detail = '\n'.join(c['paragraphs'])
        rows.append('    (%s, %s, %s, %s::jsonb, %s, %s)' % (
            sql_str(slug), sql_str(c['title']), 'E' + sql_str(detail).replace('\n', '\\n'),
            sql_str(json.dumps(c['elements'], ensure_ascii=False)),
            sql_str(f'assets/stories/story-{c["no"]}.webp'), sql_str(f'《{c["title"]}》故事情境圖')))
    return ',\n'.join(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx', nargs='?', default=DOCX)
    ap.add_argument('--json')
    ap.add_argument('--sql')
    a = ap.parse_args()
    cards = extract(a.docx)
    if [c['no'] for c in cards] != [f'{i:02d}' for i in range(1, 9)]:
        sys.exit('原稿應有 01～08 八張卡：' + ','.join(c['no'] for c in cards))
    for c in cards:
        if not c['paragraphs'] or not c['elements']:
            sys.exit(f'{c["no"]} {c["title"]}：缺少故事介紹或故事元素')
    out = json.dumps(cards, ensure_ascii=False, indent=1)
    if a.json:
        open(a.json, 'w', encoding='utf-8').write(out + '\n')
    if a.sql:
        open(a.sql, 'w', encoding='utf-8').write(sql_values(cards) + '\n')
    if not a.json and not a.sql:
        print(out)


if __name__ == '__main__':
    main()
