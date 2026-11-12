// 分類工作區畫面元件（個人分類使用；Phase 3 小組共作只需換資料來源與 onChange 處理）。
//
//   const view = createBoardView({ cards, title, onChange, readOnly })
//   view.el                 掛到頁面上的元素
//   view.setData(data)      外部資料更新（例如伺服器較新的版本）；拖曳中會延後套用
//   view.setReadOnly(bool)  唯讀（已提交、暫停、已鎖定、教師檢視、快照）
//   view.setStatus(node)    標題列右側的狀態（只在需要時顯示）
//   view.setNotice(node)    標題下方的提示列
//   view.setFooter(node)    右側底部（完成按鈕），固定可見，不隨分類增加而被推出畫面
//   onChange(data, kind)    使用者操作後的新資料；kind：add | move | delete | rename | rename-commit
//
// 觸控設計：點故事卡內容＝閱讀；拖曳只能從「⠿ 移動」把手開始（把手 touch-action:none，
// 其他區域可正常捲動）；點一下把手＝選取，再點目標分類＝移動（平板主要操作方式）。
import { h, media, confirmDialog } from './dom.js';
import * as M from './board-model.js';

const DRAG_THRESHOLD = 6;

export function createBoardView({ cards, title = '我的故事分類', categoriesTitle = '我的分類',
                                  readOnly = false, onChange = () => {}, embedded = false }) {
  let data = M.emptyBoard();
  let ro = readOnly;
  let selected = null;      // 點選移動：目前選取的故事 id
  let drag = null;          // 拖曳中的狀態
  let pendingData = null;   // 拖曳中收到的外部更新
  let press = null;       // 點選移動：在目標區域上的按壓（pointerdown → pointerup 判斷為「點一下」）

  const count = h('span.bd-count');
  const statusSlot = h('span.bd-status');
  const noticeSlot = h('div.bd-notice-slot');
  const moveBar = h('div.bd-movebar', { hidden: true });
  const unplacedList = h('div.bd-unplaced-list');
  const unplacedTitle = h('h2.bd-col-title');
  const left = h('section.bd-left.bd-drop', { 'data-drop': '' },
    unplacedTitle, h('div.bd-scroll', unplacedList));
  const addBtn = h('button.bd-add', { type: 'button', 'data-drop': '__new', onclick: onAdd }, '＋新增分類');
  const hint = h('p.bd-hint', '新增分類，將有共同特色的故事放在一起。');
  const catList = h('div.bd-cats');
  const footer = h('div.bd-footer');
  const right = h('section.bd-right',
    h('div.bd-col-head', h('h2.bd-col-title', categoriesTitle), addBtn),
    h('div.bd-scroll', hint, catList), footer);
  const el = h('div.bd' + (embedded ? '.bd-embedded' : ''),
    h('header.bd-head', h('span.bd-title', title), statusSlot, count),
    noticeSlot, moveBar, h('div.bd-body', left, right));

  const boxes = new Map();   // categoryId → { box, input, n, body, del }

  // ---------- 點選移動：點目標區域 ----------
  // 以 pointerdown／pointerup 判斷「點一下」，不依賴 click：
  // 觸控時瀏覽器的 click 可能被省略，或在把手重畫後落到後方區域，造成誤判。
  // 手指在區域上捲動時瀏覽器會送出 pointercancel，因此捲動不會被當成點選。
  const isControl = (t) => t.closest('.sc-grip, input, .bd-del, .bd-add, .bd-movebar');
  // 已在 pointerup 處理的點按，畫面會立刻重畫；瀏覽器隨後補送的 click 會落在新的元素上（例如開啟閱讀），一律忽略
  //（只忽略「同一位置、緊接著」的那一次 click；在別處的新點按照常處理）
  let ghostClick = null;
  const handled = (e) => { ghostClick = { x: e.clientX, y: e.clientY, until: Date.now() + 600 }; };
  el.addEventListener('click', (e) => {
    const g = ghostClick;
    if (!g || e.detail === 0) return;
    ghostClick = null;
    if (Date.now() < g.until && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 16) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  el.addEventListener('pointerdown', (e) => {
    press = null;
    if (!selected || ro || isControl(e.target)) return;
    const zone = e.target.closest('[data-drop]');
    if (zone && el.contains(zone)) press = { zone, x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  el.addEventListener('pointercancel', () => { press = null; });
  el.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (!p || !selected || ro || e.pointerId !== p.id) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
    const zone = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop]');
    if (zone !== p.zone) return;
    const id = selected;
    selected = null;
    handled(e);
    commitMove(id, p.zone.dataset.drop || null);
  });

  function emit(kind) { onChange(data, kind); }

  function commitMove(cardId, target) {
    if (target === '__new') {
      const r = M.addCategory(data);
      if (!r.id) return render();
      data = M.moveCard(r.data, cardId, r.id);
      render();
      emit('add');
      scrollToCat(r.id);
      return;
    }
    if ((data.placements[cardId] || null) === target) return render();
    data = M.moveCard(data, cardId, target);
    render();
    emit('move');
  }

  function onAdd() {
    if (ro) return;
    if (selected) { const id = selected; selected = null; return commitMove(id, '__new'); }
    const r = M.addCategory(data);
    if (!r.id) return;
    data = r.data;
    render();
    emit('add');
    scrollToCat(r.id);
  }

  function scrollToCat(id) {
    const b = boxes.get(id);
    if (b) requestAnimationFrame(() => b.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  async function onDelete(cat) {
    const n = M.cardsIn(data, cards, cat.id).length;
    if (n > 0) {
      const ok = await confirmDialog({ title: `刪除「${M.displayName(cat)}」？`,
        body: `裡面的 ${n} 張故事會回到「尚未分類」。`,
        buttons: [{ label: '取消', value: false }, { label: '刪除分類', value: true, danger: true }] });
      if (!ok) return;
    }
    data = M.deleteCategory(data, cat.id);
    render();
    emit('delete');
  }

  // ---------- 分類名稱：處理中文輸入法組字 ----------
  function makeBox(cat) {
    const input = h('input.bd-name', { type: 'text', maxlength: M.MAX_NAME, enterkeyhint: 'done',
      autocomplete: 'off', 'aria-label': '分類名稱' });
    let composing = false;
    const push = (kind) => {
      const id = input.dataset.cat;
      data = M.renameCategory(data, id, input.value);
      emit(kind);
    };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; push('rename'); });
    input.addEventListener('input', (e) => { if (!composing && !e.isComposing) push('rename'); });
    input.addEventListener('blur', () => { if (!composing) push('rename-commit'); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) input.blur(); });
    const n = h('span.bd-cat-n');
    const nameText = h('span.bd-name-ro');
    const del = h('button.bd-del', { type: 'button', 'aria-label': '刪除分類' }, '✕');
    const body = h('div.bd-cat-body');
    const box = h('div.bd-cat.bd-drop', { 'data-drop': cat.id },
      h('div.bd-cat-head', input, nameText, n, del), body);
    const rec = { box, input, nameText, n, body, del };
    del.addEventListener('click', () => onDelete(data.categories.find((c) => c.id === input.dataset.cat)));
    input.dataset.cat = cat.id;
    return rec;
  }

  // ---------- 故事卡 ----------
  function card(c, variant) {
    const grip = ro ? null : h('button.sc-grip', { type: 'button', 'aria-label': `移動「${c.title}」`,
      'aria-pressed': selected === c.id ? 'true' : 'false' }, h('span.sc-grip-icon', '⠿'), h('span.sc-grip-label', '移動'));
    const node = h('div.sc.sc-' + variant + (selected === c.id ? '.sc-selected' : ''), { 'data-card': c.id },
      h('button.sc-read', { type: 'button', 'aria-label': `閱讀「${c.title}」`, onclick: () => openReader(c) },
        media(c.image_url, c.image_alt || '故事圖片', 'sc-img'),
        h('span.sc-text', h('span.sc-title', c.title), variant === 'full' ? h('span.sc-sum', c.summary) : null)),
      grip);
    if (grip) attachGrip(grip, c);
    return node;
  }

  function attachGrip(grip, c) {
    const toggle = () => { selected = selected === c.id ? null : c.id; render(); };
    // 觸控／滑鼠的「點一下」在 pointerup 判斷（部分瀏覽器在觸控拖曳後會吞掉下一次 click）；
    // click 只處理鍵盤操作與不支援 pointer 事件的情況
    grip.addEventListener('click', (e) => { if (e.detail === 0) toggle(); });   // 鍵盤（Enter／空白鍵）
    grip._tap = toggle;
    grip.addEventListener('pointerdown', (e) => {
      if (drag && !drag.grip.isConnected) endDrag(false);   // 防呆：上一次按壓的把手已不存在
      if (e.button !== 0 || drag) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* 部分瀏覽器不支援 */ }
      drag = { id: c.id, grip, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
               active: false, ghost: null, target: undefined, raf: 0 };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.x = e.clientX; drag.y = e.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > DRAG_THRESHOLD) startDrag(c);
      if (drag.active) { e.preventDefault(); moveGhost(); }
    });
    grip.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) { handled(e); endDrag(true); } });
    grip.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
    grip.addEventListener('lostpointercapture', () => { if (drag && drag.grip === grip) endDrag(drag.active); });
  }

  function startDrag(c) {
    drag.active = true;
    selected = null;
    moveBar.hidden = true;
    el.classList.remove('bd-moving');
    const ghost = h('div.sc-ghost', media(c.image_url, '', 'sc-img'), h('span', c.title));
    document.body.append(ghost);
    drag.ghost = ghost;
    el.classList.add('bd-dragging');
    el.querySelector(`[data-card="${c.id}"]`)?.classList.add('sc-dragging');
    const loop = () => { if (!drag?.active) return; autoScroll(); drag.raf = requestAnimationFrame(loop); };
    drag.raf = requestAnimationFrame(loop);
  }

  function moveGhost() {
    drag.ghost.style.transform = `translate(${drag.x - 40}px, ${drag.y - 28}px)`;
    const under = document.elementFromPoint(drag.x, drag.y);
    const zone = under?.closest('[data-drop]');
    const t = zone && el.contains(zone) ? zone : null;
    if (t !== drag.target) {
      drag.target?.classList?.remove('bd-over');
      t?.classList.add('bd-over');
      drag.target = t;
    }
  }

  function autoScroll() {
    for (const sc of el.querySelectorAll('.bd-scroll')) {
      const r = sc.getBoundingClientRect();
      if (drag.x < r.left || drag.x > r.right) continue;
      const edge = 56;
      if (drag.y < r.top + edge && drag.y > r.top - 20) sc.scrollTop -= 12;
      else if (drag.y > r.bottom - edge && drag.y < r.bottom + 40) sc.scrollTop += 12;
    }
  }

  function endDrag(drop) {
    const d = drag;
    drag = null;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    if (pendingData) { data = pendingData; pendingData = null; if (!d.active) render(); }
    if (!d.active) { if (drop) d.grip._tap?.(); return; }   // 只是點一下：選取／取消選取
    d.ghost?.remove();
    d.target?.classList.remove('bd-over');
    el.classList.remove('bd-dragging');
    const target = drop && d.target ? (d.target.dataset.drop || null) : undefined;
    if (target !== undefined && !ro) commitMove(d.id, target);
    else render();
  }

  // ---------- 閱讀視窗（不改變分類，關閉後回到原位置） ----------
  function openReader(c) {
    if (drag?.active) return;
    const close = () => { dlg.close(); dlg.remove(); };
    const dlg = h('dialog.reader',
      h('div.reader-inner',
        media(c.image_url, c.image_alt || '故事圖片', 'reader-img'),
        h('h2.reader-title', c.title),
        c.summary ? h('p.reader-sum', c.summary) : null,
        h('div.reader-detail', c.detail || '')),
      h('div.reader-actions', h('button.primary.s-big', { type: 'button', onclick: close }, '關閉')));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('.reader-inner').scrollTop = 0;
  }

  // ---------- 繪製 ----------
  function render() {
    const placed = M.placedCount(data, cards);
    count.textContent = `已分類 ${placed} / ${cards.length}`;
    el.classList.toggle('bd-ro', ro);
    el.classList.toggle('bd-moving', Boolean(selected) && !ro);
    addBtn.hidden = ro;
    addBtn.textContent = selected ? '＋新增分類並放入' : '＋新增分類';
    hint.hidden = ro || data.categories.length > 0;

    const un = M.unplacedCards(data, cards);
    unplacedTitle.textContent = `尚未分類（${un.length}）`;
    unplacedList.replaceChildren(...(un.length ? un.map((c) => card(c, 'full'))
      : [h('p.bd-empty', ro ? '—' : '全部故事都已分類。')]));

    const seen = new Set();
    let prev = null;
    for (const cat of data.categories) {
      seen.add(cat.id);
      let b = boxes.get(cat.id);
      if (!b) { b = makeBox(cat); boxes.set(cat.id, b); }
      const inCat = M.cardsIn(data, cards, cat.id);
      if (document.activeElement !== b.input) b.input.value = cat.name;
      b.input.placeholder = M.tempName(cat);
      b.input.hidden = ro;
      b.nameText.hidden = !ro;
      b.nameText.textContent = M.displayName(cat);
      b.nameText.classList.toggle('temp', M.isTempName(cat.name));
      b.del.hidden = ro;
      b.n.textContent = `${inCat.length} 張`;
      b.body.replaceChildren(...(inCat.length ? inCat.map((c) => card(c, 'compact'))
        : [h('p.bd-drop-hint', ro ? '（沒有故事）' : '把故事拖到這裡，或點故事的「移動」再點這裡')]));
      // 只在順序不同時才移動節點，避免正在輸入的名稱欄位失去焦點
      const want = prev ? prev.nextSibling : catList.firstChild;
      if (want !== b.box) catList.insertBefore(b.box, want);
      prev = b.box;
    }
    for (const [id, b] of boxes) if (!seen.has(id)) { b.box.remove(); boxes.delete(id); }

    if (selected && !ro) {
      const c = cards.find((x) => x.id === selected);
      moveBar.hidden = false;
      moveBar.replaceChildren(h('span', `已選取「${c?.title || ''}」：請點選要放入的分類`,
        data.placements[selected] ? '，或點「尚未分類」放回。' : '。'),
        h('button', { type: 'button', onclick: () => { selected = null; render(); } }, '取消'));
    } else {
      moveBar.hidden = true;
    }
  }

  render();

  return {
    el,
    get data() { return data; },
    setData(d) {
      const next = M.normalize(d, cards);
      // 手指按在把手上時（含尚未開始拖曳）延後套用，避免重畫把手造成放開事件遺失
      if (drag) { pendingData = next; return; }
      if (M.sameBoard(next, data) && next.categories.every((c, i) => c.name === data.categories[i]?.name)) return;
      data = next;
      if (selected && !cards.some((c) => c.id === selected)) selected = null;
      render();
    },
    setReadOnly(v) {
      if (ro === Boolean(v)) return;
      ro = Boolean(v);
      if (ro) { selected = null; if (drag?.active) endDrag(false); }
      render();
    },
    setStatus(node) { statusSlot.replaceChildren(...(node ? [node] : [])); },
    setNotice(node) { noticeSlot.replaceChildren(...(node ? [node] : [])); },
    setFooter(node) { footer.replaceChildren(...(node ? [node] : [])); footer.hidden = !node; },
    isEditingName() { return [...boxes.values()].some((b) => b.input === document.activeElement); },
    destroy() { if (drag?.active) endDrag(false); document.querySelectorAll('dialog.reader').forEach((d) => d.remove()); },
  };
}
