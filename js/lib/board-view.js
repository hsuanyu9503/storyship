// 分類工作區畫面元件（個人分類使用；Phase 3 小組共作只需換資料來源與 onChange 處理）。
//
//   const view = createBoardView({ cards, title, onChange, readOnly })
//   view.el                 掛到頁面上的元素
//   view.setData(data)      外部資料更新（例如伺服器較新的版本）；拖曳中會延後套用
//   view.setReadOnly(bool)  唯讀（已提交、暫停、已鎖定、教師檢視、快照）
//   view.setStatus(node)    標題列右側的狀態（只在需要時顯示）
//   view.setNotice(node)    標題下方的提示列
//   view.setFooter(node)    右側底部（完成按鈕），固定可見，不隨分類增加而被推出畫面
//   onChange(data, kind, info)  使用者操作後的新資料；kind：add | move | delete | rename | rename-commit |
//                           reason | reason-commit；info：{ categoryId, cardId }
//
// Phase 3（小組共作）另外提供：
//   reasons: true           每個分類顯示「共同特色」多行欄位
//   view.setLocks(targets)  其他組員持有的操作鎖（Set：'card:<id>'、'name:<id>'、'reason:<id>'）：
//                           該卡片暫時不能移動、該欄位暫時不能輸入（只鎖該卡／該欄位，不鎖整個工作區）
//   onGrab(cardId) / onRelease(cardId)   選取或開始拖曳某張卡時（用來向伺服器取得卡片操作鎖）
//   onFieldFocus(catId, field) / onFieldBlur(catId, field)   開始／結束輸入名稱或共同特色
//   view.cancelGrab(cardId)  伺服器拒絕取得操作權時取消選取／拖曳
//   variant: 'panel'         左側個人參考面板（單欄、唯讀）
//
// 觸控設計：點故事卡內容＝閱讀；拖曳只能從「⠿ 移動」把手開始（把手 touch-action:none，
// 其他區域可正常捲動）；點一下把手＝選取，再點目標分類＝移動（平板主要操作方式）。
import { h, media, confirmDialog } from './dom.js';
import * as M from './board-model.js';

const DRAG_THRESHOLD = 6;

export function createBoardView({ cards, title = '我的故事分類', categoriesTitle = '我的分類',
                                  readOnly = false, onChange = () => {}, embedded = false,
                                  reasons = false, variant = '', confirmEveryDelete = false,
                                  onGrab = () => {}, onRelease = () => {},
                                  onFieldFocus = () => {}, onFieldBlur = () => {}, makeId = null,
                                  maxCategories = M.MAX_CATEGORIES }) {
  let silentBlur = false;   // 程式取消輸入時的 blur：不送出「離開欄位就儲存」
  let locks = new Set();    // 其他組員持有的操作鎖
  let needRender = false;   // 按壓把手期間延後的重畫
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
  const el = h('div.bd' + (embedded ? '.bd-embedded' : '') + (variant ? '.bd-' + variant : '') + (reasons ? '.bd-adaptive' : ''),
    h('header.bd-head', h('span.bd-title', title), statusSlot, count),
    noticeSlot, moveBar, h('div.bd-body', left, right));

  const boxes = new Map();   // categoryId → { box, input, n, body, del }

  // ---------- 點選移動：點目標區域 ----------
  // 以 pointerdown／pointerup 判斷「點一下」，不依賴 click：
  // 觸控時瀏覽器的 click 可能被省略，或在把手重畫後落到後方區域，造成誤判。
  // 手指在區域上捲動時瀏覽器會送出 pointercancel，因此捲動不會被當成點選。
  const isControl = (t) => t.closest('.sc-grip, input, textarea, .bd-del, .bd-add, .bd-movebar');
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

  function emit(kind, info = {}) { onChange(data, kind, info); }

  function commitMove(cardId, target) {
    if (target === '__new') {
      const r = M.addCategory(data, makeId, maxCategories);
      if (!r.id) return render();
      data = M.moveCard(r.data, cardId, r.id);
      render();
      emit('add', { categoryId: r.id, cardId });
      scrollToCat(r.id);
      return;
    }
    if ((data.placements[cardId] || null) === target) { onRelease(cardId); return render(); }
    if (target && !data.categories.some((c) => c.id === target)) { onRelease(cardId); return render(); }
    data = M.moveCard(data, cardId, target);
    render();
    emit('move', { cardId, categoryId: target });
  }

  function onAdd() {
    if (ro) return;
    if (selected) { const id = selected; selected = null; return commitMove(id, '__new'); }
    const r = M.addCategory(data, makeId, maxCategories);
    if (!r.id) return;
    data = r.data;
    render();
    emit('add', { categoryId: r.id });
    scrollToCat(r.id);
  }

  function scrollToCat(id) {
    const b = boxes.get(id);
    if (b) requestAnimationFrame(() => b.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  async function onDelete(cat) {
    if (!cat) return;
    if (locks.has('name:' + cat.id) || locks.has('reason:' + cat.id)) return;   // 組員正在輸入：伺服器也會拒絕
    const n = M.cardsIn(data, cards, cat.id).length;
    if (n > 0 || confirmEveryDelete) {
      const ok = await confirmDialog({ title: `刪除「${M.displayName(cat)}」？`,
        body: n > 0 ? `裡面的 ${n} 張故事會回到「尚未分類」。` : '這個分類裡沒有故事。',
        buttons: [{ label: '取消', value: false }, { label: '刪除分類', value: true, danger: true }] });
      if (!ok) return;
      if (!data.categories.some((c) => c.id === cat.id)) return;   // 等待確認時已被組員刪除
    }
    data = M.deleteCategory(data, cat.id);
    render();
    emit('delete', { categoryId: cat.id });
  }

  // ---------- 分類名稱與共同特色：處理中文輸入法組字 ----------
  // 組字中（compositionstart～compositionend）不送出，避免把未完成的注音反覆送到伺服器；
  // 欄位有焦點時，外部更新不會改寫輸入框內容（游標不跳動、文字不消失）。
  function bindText(el, field, getId, apply) {
    let composing = false;
    const push = (kind) => {
      if (el.readOnly) return;
      data = apply(data, getId(), el.value);
      // baseRev：輸入框目前顯示內容的版本（小組共作用來判斷編輯是基於哪個版本）
      emit(kind, { categoryId: getId(), field, baseRev: el._rev ?? null });
    };
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; push(field === 'name' ? 'rename' : 'reason'); });
    el.addEventListener('input', (e) => { if (!composing && !e.isComposing) push(field === 'name' ? 'rename' : 'reason'); });
    el.addEventListener('focus', () => { if (!el.readOnly) onFieldFocus(getId(), field); });
    el.addEventListener('blur', () => {
      if (!composing && !silentBlur) push(field === 'name' ? 'rename-commit' : 'reason-commit');
      composing = false;
      onFieldBlur(getId(), field);
    });
    if (field === 'name') el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) el.blur(); });
  }

  function makeBox(cat) {
    const getId = () => box.dataset.drop;
    const input = h('input.bd-name', { type: 'text', maxlength: M.MAX_NAME, enterkeyhint: 'done',
      autocomplete: 'off', 'aria-label': '分類名稱' });
    bindText(input, 'name', getId, M.renameCategory);
    const n = h('span.bd-cat-n');
    const nameText = h('span.bd-name-ro');
    const nameLock = h('span.bd-lock', { hidden: true }, '組員輸入中…');
    const del = h('button.bd-del', { type: 'button', 'aria-label': '刪除分類' }, '✕');
    const body = h('div.bd-cat-body');
    let reason = null; let reasonText = null; let reasonLock = null;
    if (reasons) {
      reason = h('textarea.bd-reason', { rows: 2, maxlength: M.MAX_REASON, placeholder: '這幾個故事有什麼共同特色？',
        'aria-label': '共同特色' });
      bindText(reason, 'reason', getId, M.setReason);
      reasonText = h('p.bd-reason-ro');
      reasonLock = h('span.bd-lock', { hidden: true }, '組員輸入中…');
    }
    const box = h('div.bd-cat.bd-drop', { 'data-drop': cat.id },
      h('div.bd-cat-head', input, nameText, nameLock, n, del), body,
      reasons ? h('div.bd-reason-wrap', h('span.bd-reason-label', '共同特色'), reason, reasonText, reasonLock) : null);
    del.addEventListener('click', () => onDelete(data.categories.find((c) => c.id === getId())));
    return { box, input, nameText, nameLock, n, body, del, reason, reasonText, reasonLock };
  }

  // ---------- 故事卡 ----------
  function card(c, variant) {
    const lockedByOther = locks.has('card:' + c.id);
    const grip = ro ? null : lockedByOther
      ? h('span.sc-grip.sc-grip-locked', { 'aria-label': '組員操作中' }, h('span.sc-grip-icon', '…'), h('span.sc-grip-label', '組員操作中'))
      : h('button.sc-grip', { type: 'button', 'aria-label': `移動「${c.title}」`,
          'aria-pressed': selected === c.id ? 'true' : 'false' }, h('span.sc-grip-icon', '⠿'), h('span.sc-grip-label', '移動'));
    const node = h('div.sc.sc-' + variant + (selected === c.id ? '.sc-selected' : '') + (lockedByOther ? '.sc-locked' : ''), { 'data-card': c.id },
      h('button.sc-read', { type: 'button', 'aria-label': `閱讀「${c.title}」`, onclick: () => openReader(c) },
        media(c.image_url, c.image_alt || '故事圖片', 'sc-img'),
        h('span.sc-text', h('span.sc-title', c.title), variant === 'full' ? h('span.sc-sum', c.summary) : null)),
      grip);
    if (grip && !lockedByOther) attachGrip(grip, c);
    return node;
  }

  function attachGrip(grip, c) {
    const toggle = () => {
      if (selected === c.id) { selected = null; onRelease(c.id); }
      else { const prev = selected; selected = c.id; if (prev) onRelease(prev); onGrab(c.id); }
      render();
    };
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
    if (selected && selected !== c.id) onRelease(selected);
    selected = null;
    onGrab(c.id);
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
    if (pendingData || needRender) {
      if (pendingData) data = pendingData;
      pendingData = null; needRender = false;
      if (!d.active) render();
    }
    if (!d.active) { if (drop) d.grip._tap?.(); return; }   // 只是點一下：選取／取消選取
    d.ghost?.remove();
    d.target?.classList.remove('bd-over');
    el.classList.remove('bd-dragging');
    const target = drop && d.target ? (d.target.dataset.drop || null) : undefined;
    if (target !== undefined && !ro) commitMove(d.id, target);
    else { onRelease(d.id); render(); }
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
    if (selected && locks.has('card:' + selected)) selected = null;   // 組員已取得這張卡
    const placed = M.placedCount(data, cards);
    count.textContent = `已分類 ${placed} / ${cards.length}`;
    el.classList.toggle('bd-ro', ro);
    el.classList.toggle('bd-moving', Boolean(selected) && !ro);
    addBtn.hidden = ro;
    addBtn.disabled = data.categories.length >= maxCategories;
    addBtn.textContent = selected ? '＋新增分類並放入' : '＋新增分類';
    hint.hidden = ro || data.categories.length > 0;

    const un = M.unplacedCards(data, cards);
    el.classList.toggle('bd-all-placed', un.length === 0);
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
      const nameLocked = locks.has('name:' + cat.id);
      if (document.activeElement !== b.input || nameLocked) { b.input.value = cat.name; b.input._rev = cat.nameRev; }
      b.input.placeholder = M.tempName(cat);
      b.input.hidden = ro;
      b.input.readOnly = nameLocked;
      b.input.classList.toggle('bd-field-locked', nameLocked);
      b.nameLock.hidden = ro || !nameLocked;
      b.nameText.hidden = !ro;
      b.nameText.textContent = M.displayName(cat);
      b.nameText.classList.toggle('temp', M.isTempName(cat.name));
      if (b.reason) {
        const rLocked = locks.has('reason:' + cat.id);
        if (document.activeElement !== b.reason || rLocked) { b.reason.value = cat.reason || ''; b.reason._rev = cat.reasonRev; }
        b.reason.hidden = ro;
        b.reason.readOnly = rLocked;
        b.reason.classList.toggle('bd-field-locked', rLocked);
        b.reasonLock.hidden = ro || !rLocked;
        b.reasonText.hidden = !ro;
        b.reasonText.textContent = (cat.reason || '').trim() || '（尚未寫共同特色）';
        b.reasonText.classList.toggle('temp', !(cat.reason || '').trim());
      }
      b.del.hidden = ro;
      b.del.disabled = nameLocked || locks.has('reason:' + cat.id);
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
        h('button', { type: 'button', onclick: () => { const id = selected; selected = null; onRelease(id); render(); } }, '取消'));
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
      if (M.sameBoard(next, data) && next.categories.every((c, i) => c.name === data.categories[i]?.name
          && (c.reason ?? '') === (data.categories[i]?.reason ?? '')
          && c.nameRev === data.categories[i]?.nameRev && c.reasonRev === data.categories[i]?.reasonRev)) return;
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
    isEditingName() { return [...boxes.values()].some((b) => b.input === document.activeElement || b.reason === document.activeElement); },
    // 目前正在輸入的欄位（{ categoryId, field }）
    editingField() {
      for (const [id, b] of boxes) {
        if (b.input === document.activeElement) return { categoryId: id, field: 'name' };
        if (b.reason && b.reason === document.activeElement) return { categoryId: id, field: 'reason' };
      }
      return null;
    },
    setLocks(set) {
      const next = new Set(set || []);
      if (next.size === locks.size && [...next].every((x) => locks.has(x))) return;
      locks = next;
      if (drag) {   // 按壓把手中：不重畫把手（避免放開事件遺失）；若正拖曳的卡被組員取得則取消
        needRender = true;
        if (drag.active && locks.has('card:' + drag.id)) endDrag(false);
        return;
      }
      render();
    },
    // 程式取消目前的輸入（例如伺服器回報衝突）：失去焦點但不送出欄位內容，接著以資料重畫
    cancelEdit() {
      const a = document.activeElement;
      if (!a || !el.contains(a)) return;
      silentBlur = true;
      try { a.blur(); } finally { silentBlur = false; }
      render();
    },
    cancelGrab(cardId) {
      if (drag?.active && drag.id === cardId) endDrag(false);
      if (selected === cardId) { selected = null; render(); }
    },
    destroy() { if (drag?.active) endDrag(false); document.querySelectorAll('dialog.reader').forEach((d) => d.remove()); },
  };
}
