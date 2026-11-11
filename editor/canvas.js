/* Runs inside the editor's preview frame: draws the page with the same renderer
   the published site uses, and handles selecting, dragging, resizing and text editing. */
(function () {
  'use strict';
  const PITCH = 24;                       // one grid row + gap, in px
  const E = () => parent.Editor;
  const main = document.getElementById('main');
  const $ = (s, r) => (r || document).querySelector(s);
  let S, drag = null, editing = null, cache = {}, siteStamp = '';

  const ctx = () => ({ site: S.site, sermons: S.all.sermons, events: S.all.events, editing: true });
  const secById = id => S.doc.sections.find(s => s.id === id);
  const findBlock = id => { for (const s of S.doc.sections) { const b = s.blocks.find(b => b.id === id); if (b) return { sec: s, b }; } return {}; };
  const addBar = i => `<div class="ed-add"><button data-act="addsec" data-i="${i}">＋ Add section</button></div>`;

  function sectionHtml(sec) {
    const wrap = document.createElement('div');
    wrap.innerHTML = Render.renderSection(sec, ctx());
    const el = wrap.firstChild;
    if (!sec.blocks.length) $('.sec-grid', el).insertAdjacentHTML('beforeend', '<div class="ed-empty">Empty section. Pick a block from “Add” on the left.</div>');
    el.insertAdjacentHTML('beforeend', '<button class="ed-sectab" data-act="sec">Section settings</button>');
    return el;
  }

  function render(force) {
    S = E().S;
    $('#theme').textContent = Render.themeCss(S.site);
    const href = E().fontsHref(); if ($('#gf').getAttribute('href') !== href) $('#gf').setAttribute('href', href);
    const stamp = JSON.stringify(S.site) + S.all.sermons.length + S.all.events.length;
    if (stamp !== siteStamp) { force = true; siteStamp = stamp; $('#head').innerHTML = Render.renderHeader(S.site); $('#foot').innerHTML = Render.renderFooter(S.site); }
    document.documentElement.classList.toggle('mobile', S.mode === 'm');
    if (S.kind !== 'pages') {
      main.innerHTML = '<div class="ed-note">Preview. Edit this item using the panel on the right.</div>' + (S.kind === 'sermons' ? Render.renderSermon(S.doc, ctx()) : Render.renderEvent(S.doc, ctx()));
      cache = {}; return;
    }
    const ids = S.doc.sections.map(s => s.id).join(',');
    const current = [...main.querySelectorAll(':scope > .sec')].map(e => e.dataset.id).join(',');
    if (force || ids !== current) {
      main.innerHTML = ''; cache = {};
      main.insertAdjacentHTML('beforeend', addBar(0));
      S.doc.sections.forEach((sec, i) => { main.appendChild(sectionHtml(sec)); cache[sec.id] = JSON.stringify(sec); main.insertAdjacentHTML('beforeend', addBar(i + 1)); });
    } else {
      S.doc.sections.forEach(sec => {
        const json = JSON.stringify(sec);
        if (cache[sec.id] !== json) { main.querySelector(`.sec[data-id="${sec.id}"]`).replaceWith(sectionHtml(sec)); cache[sec.id] = json; }
      });
    }
    mark();
  }

  /* Show selection outline + resize handles. */
  function mark() {
    S = E().S;
    document.querySelectorAll('.ed-selected,.ed-secsel').forEach(e => e.classList.remove('ed-selected', 'ed-secsel'));
    document.querySelectorAll('.ed-box').forEach(e => e.remove());
    if (S.kind !== 'pages') return;
    const secEl = S.sel.sec && main.querySelector(`.sec[data-id="${S.sel.sec}"]`);
    if (secEl) secEl.classList.add('ed-secsel');
    const el = S.sel.blk && main.querySelector(`.blk[data-id="${S.sel.blk}"]`);
    if (el) {
      el.classList.add('ed-selected');
      el.insertAdjacentHTML('beforeend', '<div class="ed-box">' + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => `<i data-dir="${d}"></i>`).join('') +
        '<div class="ed-tools"><button data-act="dup" title="Duplicate">⧉</button><button data-act="front" title="Bring forward">▲</button><button data-act="back" title="Send backward">▼</button><button data-act="del" title="Delete">✕</button></div></div>');
    }
  }

  /* ---------- drag + resize ---------- */
  function materializeMobile(sec, secEl) {
    const els = [...secEl.querySelectorAll('.blk')].filter(e => e.offsetParent !== null).sort((a, b) => a.offsetTop - b.offsetTop);
    const m = {}; let cursor = 0;
    els.forEach(el => { const h = Math.max(1, Math.round((el.offsetHeight + 12) / PITCH)); m[el.dataset.id] = { x: 0, y: cursor, w: 8, h }; cursor += h + 1; });
    E().change(() => {
      sec.blocks.forEach(b => { if (m[b.id]) b.m = m[b.id]; else { b.hideMobile = true; b.m = { x: 0, y: cursor, w: 8, h: 2 }; } });
      sec.mobileCustom = true;
    });
  }

  function beginDrag(e, secId, blkId, dir) {
    drag = { secId, blkId, dir, px: e.pageX, py: e.pageY, moved: false };
    document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp, { once: true });
  }
  function setupDrag() {
    const key = S.mode === 'm' ? 'm' : 'd';
    let secEl = main.querySelector(`.sec[data-id="${drag.secId}"]`);
    const sec = secById(drag.secId);
    if (key === 'm' && !sec.mobileCustom) { materializeMobile(sec, secEl); secEl = main.querySelector(`.sec[data-id="${drag.secId}"]`); }
    const { b } = findBlock(drag.blkId);
    if (key === 'm' && !b.m) b.m = { x: 0, y: 0, w: 8, h: b.d.h };
    const grid = $('.sec-grid', secEl), cs = getComputedStyle(grid), cols = key === 'm' ? 8 : 24;
    const inner = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    Object.assign(drag, { key, cols, grid, secEl, el: $(`.blk[data-id="${drag.blkId}"]`, secEl), start: Object.assign({}, b[key]), cur: Object.assign({}, b[key]), colPitch: (inner + 12) / cols });
    const guide = document.createElement('div'); guide.className = 'ed-cols'; guide.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
    guide.innerHTML = '<span></span>'.repeat(cols); grid.appendChild(guide);
    document.documentElement.classList.add('ed-dragging');
  }
  function onMove(e) {
    if (!drag) return;
    if (!drag.moved) { if (Math.abs(e.pageX - drag.px) + Math.abs(e.pageY - drag.py) < 5) return; drag.moved = true; setupDrag(); }
    const s = drag.start, c = drag.cols, dir = drag.dir, g = Object.assign({}, s);
    const dx = Math.round((e.pageX - drag.px) / drag.colPitch), dy = Math.round((e.pageY - drag.py) / PITCH);
    if (dir === 'move') { g.x = Math.max(0, Math.min(c - s.w, s.x + dx)); g.y = Math.max(0, s.y + dy); }
    else {
      if (dir.includes('e')) g.w = Math.max(1, Math.min(c - s.x, s.w + dx));
      if (dir.includes('w')) { g.x = Math.max(0, Math.min(s.x + s.w - 1, s.x + dx)); g.w = s.w - (g.x - s.x); }
      if (dir.includes('s')) g.h = Math.max(1, s.h + dy);
      if (dir.includes('n')) { g.y = Math.max(0, Math.min(s.y + s.h - 1, s.y + dy)); g.h = s.h - (g.y - s.y); }
    }
    drag.cur = g;
    const p = drag.key === 'm' ? '--m' : '--', st = drag.el.style;
    st.setProperty(p + 'x', g.x + 1); st.setProperty(p + 'y', g.y + 1); st.setProperty(p + 'w', g.w); st.setProperty(p + 'h', g.h);
    if (e.clientY > innerHeight - 50) scrollBy(0, 14); else if (e.clientY < 50) scrollBy(0, -14);
  }
  function onUp(e) {
    document.removeEventListener('pointermove', onMove);
    const d = drag; drag = null;
    document.documentElement.classList.remove('ed-dragging');
    document.querySelectorAll('.ed-cols').forEach(x => x.remove());
    if (!d || !d.moved) return;
    let target = null;
    if (d.dir === 'move' && d.key === 'd') {
      const over = document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList && x.classList.contains('sec'));
      if (over && over.dataset.id !== d.secId) target = over;
    }
    E().change(() => {
      const { sec, b } = findBlock(d.blkId);
      b[d.key] = d.cur;
      if (target) {
        const grid = $('.sec-grid', target), top = grid.getBoundingClientRect().top + scrollY + parseFloat(getComputedStyle(grid).paddingTop);
        b.d.y = Math.max(0, Math.round((e.pageY - top) / PITCH)); b.m = null;
        sec.blocks.splice(sec.blocks.indexOf(b), 1); secById(target.dataset.id).blocks.push(b);
        S.sel.sec = target.dataset.id;
      }
    });
    E().refreshInspector();
  }

  /* ---------- inline text editing ---------- */
  const BAR = [['p', 'Text', 'formatBlock', 'p'], ['h1', 'H1', 'formatBlock', 'h1'], ['h2', 'H2', 'formatBlock', 'h2'], ['h3', 'H3', 'formatBlock', 'h3'], ['h4', 'H4', 'formatBlock', 'h4'], ['|'],
    ['b', '<b>B</b>', 'bold'], ['i', '<i>I</i>', 'italic'], ['u', '<u>U</u>', 'underline'], ['|'], ['ul', '• List', 'insertUnorderedList'], ['ol', '1. List', 'insertOrderedList'], ['q', '“ Quote', 'formatBlock', 'blockquote'], ['|'],
    ['link', 'Link', 'link'], ['unlink', 'Unlink', 'unlink'], ['clear', 'Clear', 'removeFormat'], ['|'], ['done', 'Done', 'done']];
  function startEdit(blkEl) {
    const rt = $('.rt', blkEl); if (!rt) return;
    editing = { id: blkEl.dataset.id, rt, blkEl };
    rt.contentEditable = 'true'; blkEl.classList.add('ed-editing'); rt.focus();
    const bar = document.createElement('div'); bar.className = 'ed-textbar';
    bar.innerHTML = BAR.map(b => b[0] === '|' ? '<s></s>' : `<button data-cmd="${b[2]}" data-arg="${b[3] || ''}">${b[1]}</button>`).join('');
    bar.addEventListener('mousedown', ev => {
      ev.preventDefault(); const btn = ev.target.closest('button'); if (!btn) return;
      const cmd = btn.dataset.cmd;
      if (cmd === 'done') return endEdit();
      if (cmd === 'link') { const url = prompt('Link address (a page like /about, or a full https:// address):', ''); if (url) document.execCommand('createLink', false, url); return; }
      document.execCommand(cmd, false, btn.dataset.arg || null);
    });
    document.body.appendChild(bar);
  }
  function endEdit() {
    if (!editing) return;
    const { id, rt, blkEl } = editing; editing = null;
    document.querySelectorAll('.ed-textbar').forEach(b => b.remove());
    rt.contentEditable = 'false'; blkEl.classList.remove('ed-editing');
    const html = rt.innerHTML.replace(/<div>/g, '<p>').replace(/<\/div>/g, '</p>').replace(/ style="[^"]*"/g, '');
    const { b } = findBlock(id);
    if (b && b.props.html !== html) E().change(() => { b.props.html = html; });
  }
  main.addEventListener('paste', e => {
    if (!editing) return; e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  });

  /* ---------- events ---------- */
  main.addEventListener('pointerdown', e => {
    if (S.kind !== 'pages' || e.button !== 0 || e.target.closest('[data-act]')) return;
    const blkEl = e.target.closest('.blk'), secEl = e.target.closest('.sec');
    if (editing) { if (blkEl && blkEl.dataset.id === editing.id) return; endEdit(); }
    if (!secEl) return;
    if (!blkEl) { E().select(secEl.dataset.id, null); return; }
    const dir = e.target.dataset.dir || 'move', secId = secEl.dataset.id, blkId = blkEl.dataset.id;
    E().select(secId, blkId);
    beginDrag(e, secId, blkId, dir); e.preventDefault();
  });
  main.addEventListener('dblclick', e => { const el = e.target.closest('.blk-text'); if (el && S.kind === 'pages' && !editing) startEdit(el); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a'); if (a) e.preventDefault();
    const act = e.target.closest('[data-act]');
    if (act) {
      const name = act.dataset.act;
      if (name === 'addsec') E().addSection(+act.dataset.i);
      else if (name === 'sec') E().select(act.closest('.sec').dataset.id, null);
      else E().blockAction(name);
      return;
    }
    if (e.target.closest('#head')) E().openSite('Header');
    else if (e.target.closest('#foot')) E().openSite('Footer');
  }, true);
  document.addEventListener('keydown', e => {
    if (editing) { if (e.key === 'Escape') endEdit(); if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); endEdit(); E().save(); } return; }
    E().key(e);
  });

  window.Canvas = { render, mark, endEdit, isEditing: () => !!editing,
    scrollTo(id) { const el = main.querySelector(`[data-id="${id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
  if (parent.Editor && parent.Editor.ready) parent.Editor.canvasReady();
})();
