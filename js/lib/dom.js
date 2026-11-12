// 極簡 DOM 工具：h('div.class', {attrs}, children...)
export function h(sel, attrs, ...children) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;              // 僅用於程式內固定字串
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

export const $ = (s, root = document) => root.querySelector(s);

// 圖片或佔位區：url 為空時顯示虛線佔位框，方便日後替換正式素材
export function media(url, label, cls = '') {
  if (url) return h('img.media' + (cls ? '.' + cls : ''), { src: url, alt: label || '' });
  return h('div.placeholder' + (cls ? '.' + cls : ''), { role: 'img', 'aria-label': label || '圖片佔位' },
    h('span', label || '圖片佔位'));
}

export function toast(msg, kind = 'info', ms = 3000) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div.toasts'); box.id = 'toasts'; document.body.append(box); }
  const t = h('div.toast.' + kind, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// 簡單確認對話框（Promise<boolean | string>）
export function confirmDialog({ title, body, buttons = [{ label: '取消', value: false }, { label: '確定', value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const dlg = h('dialog.dialog',
      h('h3', title || ''),
      body ? h('div.dialog-body', body) : null,
      h('div.dialog-actions', buttons.map((b) =>
        h('button' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''),
          { type: 'button', onclick: () => { dlg.close(); dlg.remove(); resolve(b.value); } }, b.label))));
    dlg.addEventListener('cancel', () => { dlg.remove(); resolve(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
