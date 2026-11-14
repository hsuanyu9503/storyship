#!/usr/bin/env python3
"""第 01 環節「走進故事世界」：從 Word 原稿抽出投影文字（不改寫）。

來源：source-assets/intro/01走進故事世界_投影文字.docx
結構（依原稿的標題樣式與順序）：
  Title「走進故事世界」→ 單元名稱；其後的說明段落是給教師的製作說明，不上投影。
  Heading2「開場」→ 下一段＝開場語。
  Heading1「神祕故事N」→ 一則故事：
    Heading2「線索一｜發生了什麼事？」→ 線索名稱＝「｜」後的文字，下一段＝線索內文（依序三條）。
    Heading2「揭曉｜《作品》」→ 作品名稱；下一段「甲 → 乙」＝名字變化；再下一段＝揭曉說明。
  Heading1「兩個故事放在一起」→ 先是兩行「《作品》　甲 → 乙」（由兩則故事的資料重組，不另存），
    接著每一段是一個提問：第一段＝比較提問，最後一段＝命名提問。
  Heading2「接下來，換你分類」→ 轉場標題；下一段＝轉場文字。
輸出 JSON（docs/intro-source.json）。另可輸出 SQL VALUES 片段供教材腳本使用。

用法：python3 -I tools/intro_text.py [docx] [--json 輸出檔]
"""
import argparse
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DOCX = os.path.join(ROOT, 'source-assets', 'intro', '01走進故事世界_投影文字.docx')
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
NUMS = '一二三四五六七八九十'


def paragraphs(path):
    root = ET.fromstring(zipfile.ZipFile(path).read('word/document.xml'))
    for p in root.iter(W + 'p'):
        st = p.find(W + 'pPr/' + W + 'pStyle')
        yield (st.get(W + 'val') if st is not None else ''), ''.join(t.text or '' for t in p.iter(W + 't'))


def extract(path=DOCX):
    out = {'unit_title': None, 'opening': None, 'stories': [], 'compare_title': None, 'compare_lines': [], 'compare_prompts': [],
           'naming_prompt': None, 'bridge_title': None, 'bridge_text': None}
    expect = None   # 下一個一般段落要放到哪裡
    story = None; clue = None; section = None
    for style, text in paragraphs(path):
        t = text.strip()
        if style == 'Title':
            out['unit_title'] = t; expect = 'skip_note'; continue
        if style == 'Heading1':
            if t.startswith('神祕故事'):
                story = {'neutral': t, 'clues': [], 'title': None, 'name_before': None, 'name_after': None, 'reveal_text': None}
                out['stories'].append(story); section = 'story'
            else:
                out['compare_title'] = t; section = 'compare'; story = None
            expect = None
            continue
        if style == 'Heading2':
            if t == '開場':
                expect = 'opening'
            elif m := re.fullmatch(r'線索([一二三四五六七八九十])｜(.+)', t):
                clue = {'no': m.group(1), 'label': m.group(2), 'body': None}
                story['clues'].append(clue); expect = 'clue'
            elif m := re.fullmatch(r'揭曉｜《(.+)》', t):
                story['title'] = m.group(1); expect = 'names'
            else:
                out['bridge_title'] = t; section = 'bridge'; expect = 'bridge'
            continue
        if not t:
            continue
        if expect == 'skip_note':
            expect = None; continue
        if expect == 'opening':
            out['opening'] = text; expect = None
        elif expect == 'clue':
            clue['body'] = text; expect = None
        elif expect == 'names':
            a, b = [x.strip() for x in text.split('→')]
            story['name_before'], story['name_after'] = a, b; expect = 'reveal'
        elif expect == 'reveal':
            story['reveal_text'] = text; expect = None
        elif expect == 'bridge':
            out['bridge_text'] = text; expect = None
        elif section == 'compare':
            if '→' in text:
                out['compare_lines'].append(text)
            else:
                out['compare_prompts'].append(text)
    # 比較區：最後一個提問是命名提問
    if out['compare_prompts']:
        out['naming_prompt'] = out['compare_prompts'].pop()
    return out


def check(d):
    errs = []
    if len(d['stories']) != 2: errs.append('應有兩則神祕故事')
    for s in d['stories']:
        if [c['no'] for c in s['clues']] != list(NUMS[:3]) or not all(c['body'] for c in s['clues']):
            errs.append(f'{s["neutral"]}：應有線索一～三與內文')
        if not (s['title'] and s['name_before'] and s['name_after'] and s['reveal_text']):
            errs.append(f'{s["neutral"]}：缺少揭曉內容')
    for k in ('unit_title', 'opening', 'naming_prompt', 'bridge_title', 'bridge_text'):
        if not d[k]: errs.append('缺少 ' + k)
    if not d['compare_prompts']: errs.append('缺少比較提問')
    # 比較區的兩行必須與兩則揭曉一致（不另存，畫面由故事資料重組）
    want = [f'《{s["title"]}》　{s["name_before"]} → {s["name_after"]}' for s in d['stories']]
    if d['compare_lines'] != want: errs.append(f'比較區名字行與揭曉不一致：{d["compare_lines"]} / {want}')
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx', nargs='?', default=DOCX)
    ap.add_argument('--json')
    a = ap.parse_args()
    d = extract(a.docx)
    errs = check(d)
    if errs: sys.exit('\n'.join(errs))
    out = json.dumps(d, ensure_ascii=False, indent=1)
    if a.json: open(a.json, 'w', encoding='utf-8').write(out + '\n')
    else: print(out)


if __name__ == '__main__':
    main()
