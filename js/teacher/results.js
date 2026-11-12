// 教師主控端：05 分類成果大公開、07 小小故事分類師
//
// 私下預覽與公開分離
//   * 教師的選擇（draft）只存在這台裝置；預覽向伺服器呼叫唯讀的 teacher_preview_*，
//     回傳的就是公開時會產生的同一份投影資料（同一個 SQL 函式），所以「預覽＝公開後的樣子」。
//   * 只有按「公開到投影」才呼叫 teacher_publish_*（帶 session_state.rev 版本檢查），
//     伺服器保存選擇（綁定 snapshot ID）並產生投影資料；失敗時預覽不會被標成已公開。
//   * 「投影中」區塊永遠顯示伺服器的公開狀態（projector_state），與投影端同一份資料。
//   * 預覽請求帶序號，較晚回來的舊預覽一律忽略；快速連續按公開時，只在前一次完成後再送出最新的選擇。
import { rpc, errorText } from '../lib/api.js';
import { h, toast, confirmDialog } from '../lib/dom.js';
import * as R from '../lib/results-model.js';
import { createBoardView } from '../lib/board-view.js';
import { renderProjection } from '../lib/render-projection.js';

export function createResults(ctx) {
  // ctx: { client, S, renderAll, refresh, ping }
  const { client, S } = ctx;
  const st = {
    draft: { '05': null, '07': null },
    preview: { '05': null, '07': null },
    previewErr: { '05': null, '07': null },
    seq: 0,
    shownSeq: { '05': 0, '07': 0 },
    busy: false,
    pending: null,
    snapData: new Map(),   // snapshot id → data（教師閱讀與列出分類用）
  };

  const published = (phase) => (S.state?.stage_ctl || {})[phase] || null;
  const canon = (phase, c) => (phase === '05' ? R.canonCompare(c) : R.canonMatch(c));
  const same = (phase, a, b) => (phase === '05' ? R.sameCompare(a, b) : R.sameMatch(a, b));

  function draft(phase) {
    if (!st.draft[phase]) st.draft[phase] = canon(phase, published(phase) || (phase === '05' ? R.emptyCompare() : R.emptyMatch()));
    return st.draft[phase];
  }
  function isDirty(phase) {
    const pub = published(phase);
    return !same(phase, draft(phase), pub || (phase === '05' ? R.emptyCompare() : R.emptyMatch())) || !pub;
  }

  // ---------- 預覽（只讀） ----------
  function setDraft(phase, next) {
    st.draft[phase] = canon(phase, next);
    requestPreview(phase);
    ctx.renderAll();
  }

  async function requestPreview(phase) {
    const seq = ++st.seq;
    try {
      const r = await rpc(client, phase === '05' ? 'teacher_preview_compare' : 'teacher_preview_match',
        { p_session: S.session.id, p_ctl: draft(phase) });
      if (seq < st.shownSeq[phase]) return;            // 較舊的預覽晚到：忽略
      st.shownSeq[phase] = seq;
      st.preview[phase] = r.projection;
      st.previewErr[phase] = null;
    } catch (e) {
      if (seq < st.shownSeq[phase]) return;
      st.shownSeq[phase] = seq;
      st.previewErr[phase] = e.code === 'SAME_GROUP' ? '兩側不能是同一組。' : errorText(e);
    }
    ctx.renderAll();
  }

  // ---------- 公開 ----------
  async function publish(phase) {
    if (st.busy) { st.pending = phase; return; }      // 前一次完成後，再以最新的選擇公開一次
    st.busy = true;
    ctx.renderAll();
    try {
      const sent = draft(phase);
      const r = await rpc(client, phase === '05' ? 'teacher_publish_compare' : 'teacher_publish_match',
        { p_session: S.session.id, p_ctl: sent, p_expected_rev: S.state.rev });
      if (!r.ok && r.code === 'STALE') {
        toast('公開內容已在另一台裝置更新，已重新載入。你的預覽保留，確認後可再公開。', 'warn', 5000);
      } else if (r.ok) {
        ctx.ping();
      }
    } catch (e) {
      toast((e.code === 'SAME_GROUP' ? '兩側不能是同一組。' : errorText(e)) + '（尚未公開）', 'error', 5000);
    } finally {
      await ctx.refresh();
      st.busy = false;
      ctx.renderAll();
      if (st.pending) { const p = st.pending; st.pending = null; if (isDirty(p)) publish(p); }
    }
  }

  // ---------- 快照 ----------
  async function snapData(id) {
    const inList = snaps().find((x) => x.id === id);
    if (inList?.data) return inList.data;
    if (st.snapData.has(id)) return st.snapData.get(id);
    const { data, error } = await client.from('group_snapshots').select('id,data').eq('id', id).maybeSingle();
    if (error || !data) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    st.snapData.set(id, data.data);
    ctx.renderAll();
    return data.data;
  }
  function catsOf(id) {
    if (!id) return [];
    const d = snaps().find((x) => x.id === id)?.data || st.snapData.get(id);
    if (!d) { snapData(id).catch(() => {}); return null; }   // 載入中
    return R.normalizeSnapshot(d, S.content.cards);
  }
  // 可展示＝快照中至少有一個放了故事的分類（沒有學生的組在結束時也會留下空的快照）
  const snaps = () => (S.groupSnaps || []).filter((x) => R.normalizeSnapshot(x.data, S.content.cards).length > 0);
  const allSnaps = () => S.groupSnaps || [];
  const groupOfSnap = (id) => S.groups.find((g) => g.id === snaps().find((s) => s.id === id)?.group_id);
  const snapLabel = (s) => `${R.kindLabel(s.kind)}・${new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const catLabel = (c) => (c.name && !/^分類\s*[0-9０-９]+$/.test(c.name) ? c.name : `分類 ${c.label_no || c.n}（未命名）`);

  async function viewSnapshot(id) {
    const g = groupOfSnap(id);
    const data = await snapData(id);
    const v = createBoardView({ cards: S.content.cards, title: `${g?.name || ''} 的成果（僅教師可見，不會投影）`, categoriesTitle: '小組分類',
      readOnly: true, embedded: true, reasons: true });
    v.setData(R.snapshotToBoard(data, S.content.cards));
    const s = snaps().find((x) => x.id === id);
    v.setNotice(h('div.bd-notice' + (s?.kind === 'submitted' ? '.info' : ''), snapLabel(s)));
    const dlg = h('dialog.dialog.wide', v.el,
      h('div.dialog-actions', h('button.primary', { type: 'button', onclick: () => { dlg.close(); dlg.remove(); v.destroy(); } }, '關閉')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function snapSelect(groupId, current, onPick) {
    const list = R.snapshotsOf(snaps(), groupId);
    if (list.length <= 1) return null;
    return h('select.small', { onchange: (e) => onPick(e.target.value) },
      list.map((s, i) => h('option', { value: s.id, selected: s.id === current }, (i === 0 ? '最新：' : '較早：') + snapLabel(s))));
  }

  // ---------- 公開狀態列 ----------
  function statusBar(phase) {
    const dirty = isDirty(phase);
    return h('div.rs-bar',
      !published(phase) ? h('span.rs-dirty', '○ 尚未公開任何內容（投影顯示等待畫面）')
        : dirty ? h('span.rs-dirty', '○ 預覽中，有尚未公開的變更') : h('span.rs-clean', '● 投影與預覽一致'),
      h('button.primary', { type: 'button', disabled: st.busy || Boolean(st.previewErr[phase]), onclick: () => publish(phase) },
        st.busy ? '公開中…' : '公開到投影'),
      dirty && published(phase) ? h('button', { type: 'button', onclick: () => setDraft(phase, published(phase)) }, '放棄變更（回到投影中的內容）') : null,
      st.previewErr[phase] ? h('span.error', st.previewErr[phase]) : null);
  }

  // ---------- 05 ----------
  function panel05() {
    const d = draft('05');
    if (!st.preview['05'] && !st.previewErr['05']) requestPreview('05');
    const rows = S.groups.map((g) => ({ g, latest: R.latestSnapshot(snaps(), g.id), count: R.snapshotsOf(snaps(), g.id).length,
      emptyOnly: !R.latestSnapshot(snaps(), g.id) && R.latestSnapshot(allSnaps(), g.id) }));
    const usable = rows.filter((r) => r.latest);
    const side = (name) => {
      const id = d[name];
      if (!id) return h('div.rs-side', h('h4', name === 'left' ? '左側' : '右側', h('span.muted', '（尚未選擇）')));
      const g = groupOfSnap(id);
      const cats = catsOf(id);
      const newer = R.newerSnapshot(snaps(), id);
      const pv = (st.preview['05']?.sides || []).find((x) => x.side === name);
      return h('div.rs-side',
        h('h4', `${name === 'left' ? '左側' : '右側'}：${g?.name || ''}`, h('span.tag', R.kindLabel(snaps().find((s) => s.id === id)?.kind)),
          snapSelect(g?.id, id, (v) => setDraft('05', R.setSide(d, name, v))),
          h('button.small', { type: 'button', onclick: () => setDraft('05', R.setSide(d, name, null)) }, '移除')),
        newer ? h('p.rs-new', `這一組有較新的成果（${snapLabel(newer)}）。`,
          h('button.small', { type: 'button', onclick: () => setDraft('05', R.setSide(d, name, newer.id)) }, '改用新版本（預覽）')) : null,
        cats == null ? h('p.muted.small', '載入中…') : h('div.rs-cats',
          h('div.small.muted', '揭露共同特色（預設不公開）：'),
          cats.map((c) => h('label', h('input', { type: 'checkbox', checked: d.reasons[name].includes(c.id),
            onchange: () => setDraft('05', R.toggleReason(d, name, c.id)) }), catLabel(c), c.reason ? null : h('span.muted.small', '（沒有寫）'))),
          h('div.rs-bar',
            h('button.small', { type: 'button', onclick: () => setDraft('05', { ...d, reasons: { ...d.reasons, [name]: cats.map((c) => c.id) } }) }, '全部揭露'),
            h('button.small', { type: 'button', onclick: () => setDraft('05', { ...d, reasons: { ...d.reasons, [name]: [] } }) }, '全部收合'),
            h('label.small', '聚焦 ', h('select.small', { onchange: (e) => setDraft('05', { ...d, focus: { ...d.focus, [name]: e.target.value || null } }) },
              h('option', { value: '' }, '不聚焦（顯示全部）'), cats.map((c) => h('option', { value: c.id, selected: d.focus[name] === c.id }, catLabel(c))))),
            pv && pv.pages > 1 && !d.focus[name] ? h('span.small', '頁數 ',
              h('button.small', { type: 'button', disabled: d.page[name] <= 0, onclick: () => setDraft('05', { ...d, page: { ...d.page, [name]: d.page[name] - 1 } }) }, '◀'),
              ` ${d.page[name] + 1}／${pv.pages} `,
              h('button.small', { type: 'button', disabled: d.page[name] >= pv.pages - 1, onclick: () => setDraft('05', { ...d, page: { ...d.page, [name]: d.page[name] + 1 } }) }, '▶')) : null)));
    };
    const pickTo = (name, snapId) => {
      const other = name === 'left' ? 'right' : 'left';
      const otherG = groupOfSnap(d[other]);
      if (otherG && otherG.id === snaps().find((s) => s.id === snapId)?.group_id) { toast('兩側不能是同一組，請選擇另一組。', 'warn'); return; }
      setDraft('05', R.setSide(d, name, snapId));
    };
    return h('div',
      usable.length === 0 ? h('p.pill.warn', '目前沒有任何小組有可展示的成果（小組提交或教師結束共同分類後才會產生）。') : null,
      h('div.rs-grid', rows.map(({ g, latest, count, emptyOnly }) => h('div.rs-group' + (latest ? '' : '.none'),
        h('b', g.name),
        latest ? h('span.tag' + (latest.kind === 'submitted' ? '.pub' : '.warn'), R.kindLabel(latest.kind))
          : h('span.tag', emptyOnly ? '沒有可展示的成果（沒有已分類的故事）' : '沒有可展示的成果'),
        latest && count > 1 ? h('span.small.muted', `共 ${count} 份（預設使用最新）`) : null,
        latest ? h('div.rs-actions',
          h('button.small', { type: 'button', onclick: () => viewSnapshot(latest.id) }, '私下查看'),
          h('button.small', { type: 'button', disabled: d.left === latest.id, onclick: () => pickTo('left', latest.id) }, '放左側'),
          h('button.small', { type: 'button', disabled: d.right === latest.id, onclick: () => pickTo('right', latest.id) }, '放右側')) : null))),
      side('left'), side('right'),
      h('div.rs-bar', h('label', '追蹤故事 ', h('select.rs-story', { onchange: (e) => setDraft('05', { ...d, story: e.target.value || null }) },
        h('option', { value: '' }, '不追蹤（清除醒目標示）'),
        S.content.cards.map((c) => h('option', { value: c.id, selected: d.story === c.id }, c.title))))),
      statusBar('05'),
      h('p.muted', '選組、揭露、追蹤、翻頁都只改變「預覽」區；按「公開到投影」後全班才看到。展示只讀取已保存的成果快照，不會改動學生的分類。'));
  }

  // ---------- 07 ----------
  function panel07() {
    const d = draft('07');
    if (!st.preview['07'] && !st.previewErr['07']) requestPreview('07');
    const disclosed = new Set(S.state?.disclosure?.genres || []);
    const gs = S.content.genres;
    const groupsWith = S.groups.map((g) => ({ g, latest: R.latestSnapshot(snaps(), g.id) })).filter((x) => x.latest);
    const snapG = groupOfSnap(d.snapshot);
    const cats = catsOf(d.snapshot);
    const genre = Number.isInteger(d.genre) ? gs[d.genre] : null;
    const newer = d.snapshot ? R.newerSnapshot(snaps(), d.snapshot) : null;
    return h('div',
      groupsWith.length === 0 ? h('p.pill.warn', '目前沒有任何小組有可展示的成果。') : null,
      h('div.rs-side', h('h4', '① 選擇小組與分類'),
        h('div.rs-bar',
          h('select', { onchange: (e) => setDraft('07', R.setSnapshot(d, e.target.value || null)) },
            h('option', { value: '' }, '（不選）'),
            groupsWith.map(({ g, latest }) => h('option', { value: latest.id, selected: snapG?.id === g.id }, `${g.name}（${R.kindLabel(latest.kind)}）`))),
          snapG ? snapSelect(snapG.id, d.snapshot, (v) => setDraft('07', R.setSnapshot(d, v))) : null,
          d.snapshot ? h('button.small', { type: 'button', onclick: () => viewSnapshot(d.snapshot) }, '私下查看整組') : null),
        newer ? h('p.rs-new', `這一組有較新的成果（${snapLabel(newer)}）。`,
          h('button.small', { type: 'button', onclick: () => setDraft('07', R.setSnapshot(d, newer.id)) }, '改用新版本（預覽）')) : null,
        d.snapshot ? (cats == null ? h('p.muted.small', '載入中…') : h('div.rs-cats', cats.map((c) => h('label',
          h('input', { type: 'radio', name: 'rs07cat', checked: d.category === c.id, onchange: () => setDraft('07', { ...d, category: c.id }) }),
          catLabel(c), h('span.muted.small', `（${c.cards.length} 張）`))))) : null,
        d.category ? h('label', h('input', { type: 'checkbox', checked: d.show_reason, onchange: (e) => setDraft('07', { ...d, show_reason: e.target.checked }) }), '一併顯示這一類的共同特色') : null),
      h('div.rs-side', h('h4', '② 選擇小說類型（可不選）'),
        h('div.genre-pick',
          h('button.genre-btn' + (d.genre == null ? '.sel' : ''), { type: 'button', onclick: () => setDraft('07', R.setGenre(d, null)) }, '不選類型'),
          gs.map((g, i) => h('button.genre-btn' + (d.genre === i ? '.sel' : '') + (disclosed.has(i) ? '.pub' : ''), { type: 'button', onclick: () => setDraft('07', R.setGenre(d, i)) },
            `${i + 1}. ${g.name}`, disclosed.has(i) ? ' ✓' : ''))),
        h('p.muted.small', '✓＝已在 06 或 07 公開過的類型。選了未公開過的類型，按「公開到投影」時才會揭曉。')),
      genre ? h('div.rs-side', h('h4', `③ ${genre.name} 的核心要素（逐一揭露、標示相似）`),
        h('div.rs-els', (genre.elements || []).slice(0, 3).map((e, i) => h('div.rs-el',
          h('label', h('input', { type: 'checkbox', checked: d.elements.includes(i), onchange: () => setDraft('07', R.toggleElement(d, i)) }), `揭露：${e.icon || ''} ${e.label}`),
          h('label', h('input', { type: 'checkbox', disabled: !d.elements.includes(i), checked: d.highlights.includes(i), onchange: () => setDraft('07', R.toggleHighlight(d, i)) }), '標示相似'))))) : null,
      h('div.rs-bar',
        h('label', h('input', { type: 'checkbox', checked: d.scaffold, onchange: (e) => setDraft('07', { ...d, scaffold: e.target.checked }) }), '顯示句型鷹架'),
        h('button', { type: 'button', onclick: () => setDraft('07', R.emptyMatch()) }, '清除對照')),
      statusBar('07'),
      h('p.muted', '不會自動配對、評分或改名；是否接近、接近哪一種，由全班討論。'));
  }

  function previewNode(phase) {
    if (phase !== '05' && phase !== '07') return null;
    if (st.previewErr[phase]) return h('div.preview-box', h('p.error', st.previewErr[phase]));
    if (!st.preview[phase]) return h('div.preview-box', h('p.muted', '預覽載入中…'));
    return renderProjection({ ...S.pub, projection: st.preview[phase] }, { showQr: false });
  }

  return {
    panel05, panel07, previewNode, isDirty,
    // 每次重新讀取伺服器狀態時：若沒有尚未公開的變更，預覽跟著伺服器（例如另一台裝置公開了新內容）
    onLive() {
      for (const phase of ['05', '07']) {
        if (st.draft[phase] && !st.busy && same(phase, st.draft[phase], st.lastPub?.[phase] || null)) {
          st.draft[phase] = null; st.preview[phase] = null; st.previewErr[phase] = null;
        }
      }
      st.lastPub = { '05': published('05'), '07': published('07') };
    },
    key() { return JSON.stringify([st.draft, st.shownSeq, st.previewErr, st.busy, st.snapData.size]); },
  };
}
