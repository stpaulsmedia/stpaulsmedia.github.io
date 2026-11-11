/* Website Editor: side panels, inspector, saving and publishing.
   The page itself is drawn by canvas.js inside the preview frame. */
(function () {
  'use strict';
  const R = window.Render;
  const $ = (s, r) => (r || document).querySelector(s);
  const enc = encodeURIComponent;
  const clone = o => JSON.parse(JSON.stringify(o));
  const frame = $('#canvas');
  const Canvas = () => frame.contentWindow.Canvas;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    kids.flat().forEach(c => c != null && el.append(c.nodeType ? c : document.createTextNode(c)));
    return el;
  }
  async function api(method, path, body, raw) {
    const res = await fetch('/_api/' + path, { method, body: body == null ? undefined : raw ? body : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.body.append(t);
    setTimeout(() => t.remove(), bad ? 6000 : 2600);
  }
  const getPath = (o, k) => k.split('.').reduce((a, p) => a == null ? a : a[p], o);
  function setPath(o, k, v) { const ps = k.split('.'), last = ps.pop(), t = ps.reduce((a, p) => a[p] == null ? (a[p] = {}) : a[p], o); if (v === undefined) delete t[last]; else t[last] = v; }

  /* ---------- state ---------- */
  const S = { site: null, pages: [], sermons: [], events: [], all: { sermons: [], events: [] }, kind: 'pages', slug: '', doc: null, sel: { sec: null, blk: null }, mode: 'd', dirty: false, siteDirty: false };
  let fonts = [], undo = [], redo = [], lastTag = '', lastTime = 0, tab = 'pages', openGroups = {};

  const curSection = () => S.doc && S.doc.sections && S.doc.sections.find(s => s.id === S.sel.sec);
  const curBlock = () => { const s = curSection(); return s && s.blocks.find(b => b.id === S.sel.blk); };

  function setDirty() { $('#save').classList.toggle('attn', S.dirty || S.siteDirty); $('#save').textContent = (S.dirty || S.siteDirty) ? 'Save' : 'Saved'; }

  /* Apply a change to the open document. tag groups rapid edits (slider drags) into one undo step. */
  function change(fn, tag) {
    const now = Date.now();
    if (!(tag && tag === lastTag && now - lastTime < 900)) { undo.push(JSON.stringify(S.doc)); if (undo.length > 100) undo.shift(); redo = []; }
    lastTag = tag || ''; lastTime = now;
    fn(); S.dirty = true; setDirty();
    Canvas().render();
  }
  function siteChange(fn) { fn(); S.siteDirty = true; setDirty(); Canvas().render(); }
  function step(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(S.doc)); S.doc = JSON.parse(from.pop()); S.dirty = true; setDirty(); lastTag = '';
    if (!curSection()) S.sel = { sec: null, blk: null }; else if (!curBlock()) S.sel.blk = null;
    Canvas().render(true); inspector();
  }

  function select(sec, blk) { S.sel = { sec, blk }; Canvas().mark(); inspector(); }

  /* ---------- form fields ---------- */
  function field(f, obj, commit) {
    const val = getPath(obj, f.k);
    const put = (v, structural) => commit(() => setPath(obj, f.k, v), f.k, structural);
    const wrap = h('div', { class: 'f f-' + f.t }, h('label', { class: 'f-l' }, f.label));
    let input;
    switch (f.t) {
      case 'text': case 'url': case 'date': case 'datetime':
        input = h('input', { type: f.t === 'date' ? 'date' : f.t === 'datetime' ? 'datetime-local' : 'text', value: val == null ? '' : val, list: f.t === 'url' ? 'links' : null, placeholder: f.t === 'url' ? '/page or https://…' : '', oninput: e => put(e.target.value) });
        wrap.append(input); break;
      case 'textarea': case 'code':
        wrap.append(h('textarea', { rows: f.t === 'code' ? 8 : 3, class: f.t === 'code' ? 'mono' : '', oninput: e => put(e.target.value) }, val || '')); break;
      case 'select': case 'theme': {
        const opts = f.t === 'theme' ? Object.keys(S.site.styles.themes).map(k => [k, k[0].toUpperCase() + k.slice(1)]) : f.options;
        input = h('select', { onchange: e => put(e.target.value, true) }, opts.map(o => h('option', { value: o[0], selected: String(val == null ? '' : val) === String(o[0]) }, o[1])));
        wrap.append(input); break;
      }
      case 'toggle':
        wrap.classList.add('row'); wrap.append(h('input', { type: 'checkbox', checked: !!val, onchange: e => put(e.target.checked, true) })); break;
      case 'range': {
        const unset = val == null || val === '' || (f.def === -1 && val < 0);
        const num = h('span', { class: 'f-num' }, unset ? 'Auto' : String(val));
        input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: unset ? (f.def > 0 ? f.def : f.min) : val, oninput: e => { num.textContent = e.target.value; put(+e.target.value); } });
        wrap.append(h('div', { class: 'f-range' }, input, num, f.def != null ? h('button', { class: 'mini', title: 'Reset to default', onclick: () => put(undefined, true) }, '↺') : null)); break;
      }
      case 'color': {
        const pal = S.site.styles.colors, row = h('div', { class: 'swatches' });
        for (const k in pal) row.append(h('button', { class: 'sw' + (val === k ? ' on' : ''), title: k, style: `background:${pal[k]}`, onclick: () => put(k, true) }));
        const custom = h('input', { type: 'color', title: 'Custom color', value: /^#[0-9a-f]{6}$/i.test(val || '') ? val : '#888888', oninput: e => put(e.target.value) });
        row.append(custom, h('button', { class: 'mini', title: 'Use the default', onclick: () => put(undefined, true) }, '↺'));
        wrap.append(row, h('div', { class: 'f-hint' }, val ? (pal[val] ? `“${val}” from your palette` : val) : 'Default')); break;
      }
      case 'image': {
        wrap.append(h('div', { class: 'f-img' }, val ? h('img', { src: val }) : h('div', { class: 'noimg' }, 'No image'),
          h('div', {}, h('button', { class: 'btn-s', onclick: () => mediaPicker(url => put(url, true)) }, val ? 'Change…' : 'Choose…'), val ? h('button', { class: 'btn-s ghost', onclick: () => put('', true) }, 'Remove') : null))); break;
      }
      case 'file': case 'audio': {
        const kind = f.t === 'audio' ? 'audio' : 'file';
        const pick = h('input', { type: 'file', accept: kind === 'audio' ? 'audio/mpeg,.mp3' : '', style: 'display:none', onchange: async e => {
          const file = e.target.files[0]; if (!file) return;
          toast('Uploading ' + file.name + '…');
          try {
            const r = await api('POST', `upload?kind=${kind}&name=${enc(file.name)}`, file, true);
            if (kind === 'audio') {
              const secs = await new Promise(ok => { const a = new Audio(URL.createObjectURL(file)); a.onloadedmetadata = () => ok(Math.round(a.duration)); a.onerror = () => ok(0); });
              commit(() => { obj.audio = r.url; obj.audioBytes = r.bytes; obj.duration = secs; }, f.k, true);
            } else put(r.url, true);
            toast('Uploaded');
          } catch (err) { toast(err.message, true); }
        } });
        wrap.append(h('div', { class: 'f-file' }, h('span', { class: 'f-hint' }, val ? String(val).split('/').pop() : 'Nothing chosen'), h('button', { class: 'btn-s', onclick: () => pick.click() }, val ? 'Replace…' : 'Upload…'), pick)); break;
      }
      case 'font':
        wrap.append(h('button', { class: 'fontbtn', style: val ? `font-family:'${val}'` : '', onclick: () => fontPicker(val, fnt => {
          if (f.full) commit(() => { const o = getPath(obj, f.k.replace(/\.family$/, '')); o.family = fnt.f; o.fallback = /serif/i.test(fnt.c) && !/sans/i.test(fnt.c) ? 'Georgia, serif' : /mono/i.test(fnt.c) ? 'monospace' : 'Helvetica, Arial, sans-serif'; }, f.k, true);
          else put(fnt.f, true);
        }) }, val || 'Default font')); if (!f.full && val) wrap.append(h('button', { class: 'mini', onclick: () => put(undefined, true) }, '↺')); break;
      case 'rich': {
        const ed = h('div', { class: 'rich', contenteditable: 'true', html: val || '', oninput: () => put(ed.innerHTML) });
        const cmd = (c, a) => e => { e.preventDefault(); if (c === 'link') { const u = prompt('Link address:'); if (u) document.execCommand('createLink', false, u); } else document.execCommand(c, false, a); put(ed.innerHTML); };
        ed.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
        wrap.append(h('div', { class: 'richbar' }, h('button', { onmousedown: cmd('bold') }, h('b', {}, 'B')), h('button', { onmousedown: cmd('italic') }, h('i', {}, 'I')), h('button', { onmousedown: cmd('link') }, 'Link'), h('button', { onmousedown: cmd('insertUnorderedList') }, '• List'), h('button', { onmousedown: cmd('formatBlock', 'h3') }, 'H'), h('button', { onmousedown: cmd('formatBlock', 'p') }, 'P')), ed); break;
      }
      case 'list': {
        const arr = val || []; const key = f.k;
        arr.forEach((item, i) => {
          const gk = key + ':' + i;
          const move = d => e => { e.preventDefault(); e.stopPropagation(); commit(() => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }, '', true); };
          const det = h('details', { class: 'item', open: !!openGroups[gk], ontoggle: e => { openGroups[gk] = e.target.open; } },
            h('summary', {}, h('span', { class: 'item-t' }, String(item[f.titleKey] || 'Item ' + (i + 1)).replace(/<[^>]+>/g, '').slice(0, 40)),
              h('span', { class: 'item-b' }, h('button', { class: 'mini', onclick: move(-1), title: 'Move up' }, '↑'), h('button', { class: 'mini', onclick: move(1), title: 'Move down' }, '↓'),
                h('button', { class: 'mini', title: 'Remove', onclick: e => { e.preventDefault(); commit(() => arr.splice(i, 1), '', true); } }, '✕'))));
          f.item.forEach(sub => det.append(field(sub, item, commit)));
          wrap.append(det);
        });
        wrap.append(h('button', { class: 'btn-s', onclick: () => commit(() => { if (!val) setPath(obj, f.k, arr); arr.push(clone(f.blank)); openGroups[key + ':' + (arr.length - 1)] = true; }, '', true) }, '+ Add'));
        break;
      }
    }
    return wrap;
  }
  const group = (title, body, open) => h('details', { class: 'grp', open: open || !!openGroups['g:' + title], ontoggle: e => { openGroups['g:' + title] = e.target.open; } }, h('summary', {}, title), body);

  /* ---------- inspector (right panel) ---------- */
  function inspector() {
    const box = $('#inspector'); box.innerHTML = '';
    if (!S.doc) return;
    const docCommit = (fn, tag, structural) => { change(fn, tag); if (structural) inspector(); };
    const b = curBlock(), sec = curSection();
    if (S.kind !== 'pages' || (!b && !sec)) {
      box.append(h('h2', {}, S.kind === 'pages' ? 'Page settings' : S.kind === 'sermons' ? 'Sermon' : 'Event'));
      const defs = R.DOC_FIELDS[S.kind].filter(f => !(f.k === 'slug' && S.doc.slug === 'home'));
      defs.forEach(f => box.append(field(f, S.doc, docCommit)));
      if (S.kind === 'pages') box.append(h('p', { class: 'hint' }, 'Click any block on the page to edit it. Double-click text to type. Drag blocks to move them and drag the round handles to resize.'));
      return;
    }
    if (b) {
      const def = R.BLOCKS[b.type];
      box.append(h('h2', {}, def.label), h('div', { class: 'tools' },
        h('button', { class: 'btn-s', onclick: () => blockAction('dup') }, 'Duplicate'), h('button', { class: 'btn-s', onclick: () => blockAction('front') }, 'Forward'),
        h('button', { class: 'btn-s', onclick: () => blockAction('back') }, 'Backward'), h('button', { class: 'btn-s danger', onclick: () => blockAction('del') }, 'Delete')));
      if (b.type === 'text') box.append(h('p', { class: 'hint' }, 'Double-click the text on the page to edit it.'));
      const content = h('div', {}); def.fields.forEach(f => content.append(field(f, b.props, docCommit)));
      if (def.fields.length) box.append(group('Content', content, true));
      const style = h('div', {});
      R.STYLE_FIELDS.filter(f => !/^btn/.test(f.k) || ['button', 'cards', 'staff', 'gform'].includes(b.type)).forEach(f => style.append(field(f, b.style || (b.style = {}), docCommit)));
      box.append(group('Style (overrides the site defaults)', style));
      const lay = h('div', {});
      lay.append(field({ k: 'hideMobile', t: 'toggle', label: 'Hide on phones' }, b, docCommit));
      const g = S.mode === 'm' && b.m ? b.m : b.d;
      lay.append(h('p', { class: 'hint' }, `${S.mode === 'm' && b.m ? 'Phone' : 'Desktop'} position: column ${g.x + 1}, row ${g.y + 1}, ${g.w} wide × ${g.h} tall`));
      box.append(group('Layout', lay));
      box.append(h('button', { class: 'btn-s ghost', onclick: () => select(S.sel.sec, null) }, '← Section settings'));
      return;
    }
    const i = S.doc.sections.indexOf(sec);
    const moveSec = d => () => { const j = i + d; if (j < 0 || j >= S.doc.sections.length) return; change(() => { const a = S.doc.sections; [a[i], a[j]] = [a[j], a[i]]; }); inspector(); Canvas().scrollTo(sec.id); };
    box.append(h('h2', {}, 'Section'), h('div', { class: 'tools' },
      h('button', { class: 'btn-s', onclick: moveSec(-1) }, 'Move up'), h('button', { class: 'btn-s', onclick: moveSec(1) }, 'Move down'),
      h('button', { class: 'btn-s', onclick: () => { change(() => { const c = clone(sec); c.id = R.uid(); c.blocks.forEach(x => x.id = R.uid()); S.doc.sections.splice(i + 1, 0, c); S.sel = { sec: c.id, blk: null }; }); inspector(); } }, 'Duplicate'),
      h('button', { class: 'btn-s danger', onclick: () => { if (!sec.blocks.length || confirm('Delete this section and everything in it?')) { change(() => S.doc.sections.splice(i, 1)); select(null, null); } } }, 'Delete')));
    const body = h('div', {}); R.SECTION_FIELDS.forEach(f => body.append(field(f, sec, docCommit)));
    box.append(body);
    box.append(h('div', { class: 'f' }, h('label', { class: 'f-l' }, 'Phone layout'),
      sec.mobileCustom ? h('div', {}, h('p', { class: 'hint' }, 'Custom: you arranged this section for phones.'), h('button', { class: 'btn-s', onclick: () => { change(() => { sec.mobileCustom = false; sec.blocks.forEach(x => { x.m = null; }); }); inspector(); } }, 'Reset to automatic'))
        : h('p', { class: 'hint' }, 'Automatic: blocks stack top to bottom. Switch to Phone view and drag a block to customise.')));
  }

  /* ---------- left panel ---------- */
  function sidebar() {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    const box = $('#side'); box.innerHTML = '';
    if (tab === 'pages') pagesPanel(box); else if (tab === 'add') addPanel(box); else sitePanel(box);
  }
  function pagesPanel(box) {
    const list = (kind, title, items, label) => {
      const rows = items.map(d => h('div', { class: 'row-item' + (S.kind === kind && S.slug === d.slug ? ' on' : ''), onclick: () => open(kind, d.slug) },
        h('span', { class: 'ri-t' }, d.title || '(untitled)'), h('span', { class: 'ri-s' }, kind === 'pages' ? (d.slug === 'home' ? '/' : '/' + d.slug) : R.fmtDate(d.date, true)),
        d.slug === 'home' ? null : h('button', { class: 'mini', title: 'Delete', onclick: e => { e.stopPropagation(); removeDoc(kind, d); } }, '✕')));
      return group(`${title} (${items.length})`, h('div', {}, h('button', { class: 'btn-s wide', onclick: () => createDoc(kind) }, '+ New ' + label), rows), kind === S.kind);
    };
    box.append(list('pages', 'Pages', S.pages.slice().sort((a, b) => a.slug === 'home' ? -1 : b.slug === 'home' ? 1 : a.title.localeCompare(b.title)), 'page'),
      list('sermons', 'Sermons', S.sermons.slice().sort((a, b) => a.date < b.date ? 1 : -1), 'sermon'),
      list('events', 'Events', S.events.slice().sort((a, b) => a.date < b.date ? 1 : -1), 'event'));
  }
  function addPanel(box) {
    if (S.kind !== 'pages') { box.append(h('p', { class: 'hint' }, 'Blocks can be added to pages. Sermons and events use a set layout; edit them in the panel on the right.')); return; }
    box.append(h('p', { class: 'hint' }, 'Click a block to add it to the selected section, then drag it where you want it.'));
    const grid = h('div', { class: 'palette' });
    for (const type in R.BLOCKS) grid.append(h('button', { onclick: () => addBlock(type) }, R.BLOCKS[type].label));
    box.append(grid, h('button', { class: 'btn-s wide', onclick: () => addSection(S.doc.sections.length) }, '+ Add a new section'));
  }
  function sitePanel(box) {
    const st = S.site.styles;
    const commit = (fn, tag, structural) => { siteChange(fn); if (structural) sidebar(); };
    const F = (k, t, label, o) => Object.assign({ k, t, label }, o || {});
    const make = defs => { const d = h('div', {}); defs.forEach(f => d.append(field(f, S.site, commit))); return d; };
    const linkItem = [F('label', 'text', 'Label'), F('href', 'url', 'Link')];
    const weights = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold']];
    const cases = [['none', 'As typed'], ['uppercase', 'ALL CAPS'], ['capitalize', 'Capitalize Words']];
    const colors = h('div', {});
    for (const k in st.colors) colors.append(h('div', { class: 'f row' }, h('label', { class: 'f-l' }, k), h('input', { type: 'color', value: st.colors[k], oninput: e => commit(() => { st.colors[k] = e.target.value; }) }),
      ['accent', 'dark', 'light', 'white'].includes(k) ? null : h('button', { class: 'mini', onclick: () => commit(() => { delete st.colors[k]; }, '', true) }, '✕')));
    colors.append(h('button', { class: 'btn-s', onclick: () => { const n = (prompt('Name for the new color (one word):') || '').replace(/[^a-zA-Z0-9]/g, ''); if (n && !st.colors[n]) commit(() => { st.colors[n] = '#888888'; }, '', true); } }, '+ Add color'),
      h('p', { class: 'hint' }, 'Blocks that use a palette color update everywhere when you change it here.'));
    const themes = h('div', {});
    for (const name in st.themes) themes.append(group(name[0].toUpperCase() + name.slice(1), make([F(`styles.themes.${name}.bg`, 'color', 'Background'), F(`styles.themes.${name}.text`, 'color', 'Text'), F(`styles.themes.${name}.heading`, 'color', 'Headings'),
      F(`styles.themes.${name}.accent`, 'color', 'Links & accents'), F(`styles.themes.${name}.buttonBg`, 'color', 'Button'), F(`styles.themes.${name}.buttonText`, 'color', 'Button text')])));
    themes.append(h('button', { class: 'btn-s', onclick: () => { const n = (prompt('Name for the new theme:') || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (n && !st.themes[n]) commit(() => { st.themes[n] = clone(st.themes.white); }, '', true); } }, '+ Add theme'),
      h('p', { class: 'hint' }, 'A theme is a set of colors a section can wear. Pick one per section, or override any block individually.'));
    box.append(
      group('Navigation', make([F('nav', 'list', 'Menu items', { titleKey: 'label', blank: { label: 'New item', href: '', children: [] }, item: [...linkItem, F('children', 'list', 'Dropdown items', { titleKey: 'label', blank: { label: 'New item', href: '' }, item: linkItem })] })])),
      group('Header', make([F('logo', 'image', 'Logo'), F('header.logoHeight', 'range', 'Logo height', { min: 24, max: 120 }), F('header.theme', 'theme', 'Color theme'), F('header.sticky', 'toggle', 'Stay at top when scrolling'), F('header.ctaLabel', 'text', 'Button label'), F('header.ctaHref', 'url', 'Button link')])),
      group('Footer', make([F('footer.theme', 'theme', 'Color theme'), F('footer.columns', 'list', 'Columns', { titleKey: 'title', blank: { title: 'Heading', html: '<p></p>' }, item: [F('title', 'text', 'Heading'), F('html', 'rich', 'Content')] }),
        F('footer.showSocial', 'toggle', 'Show social links'), F('footer.socialTitle', 'text', 'Social heading'), F('footer.badge', 'image', 'Badge / logo'), F('footer.badgeHref', 'url', 'Badge link'), F('footer.note', 'text', 'Small print ({year} = current year)')])),
      group('Announcement bar', make([F('announcement.enabled', 'toggle', 'Show the bar'), F('announcement.text', 'text', 'Message'), F('announcement.href', 'url', 'Link (optional)'), F('announcement.theme', 'theme', 'Color theme')])),
      group('Social links', make([F('social', 'list', 'Accounts', { titleKey: 'label', blank: { type: 'link', label: 'Link', href: '' }, item: [F('type', 'select', 'Icon', { options: [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['youtube', 'YouTube'], ['spotify', 'Spotify'], ['email', 'Email'], ['link', 'Link']] }), F('label', 'text', 'Name'), F('href', 'url', 'Address')] })])),
      h('h3', { class: 'side-h' }, 'Design'),
      group('Color palette', colors), group('Color themes', themes),
      group('Fonts', make([F('styles.fonts.heading.family', 'font', 'Heading font', { full: true }), F('styles.fonts.heading.weight', 'select', 'Heading weight', { options: weights }), F('styles.fonts.heading.transform', 'select', 'Heading case', { options: cases }),
        F('styles.fonts.heading.spacing', 'range', 'Heading letter spacing', { min: -0.06, max: 0.3, step: 0.01 }), F('styles.fonts.heading.lineHeight', 'range', 'Heading line height', { min: 0.9, max: 1.8, step: 0.05 }),
        F('styles.fonts.body.family', 'font', 'Body font', { full: true }), F('styles.fonts.body.weight', 'select', 'Body weight', { options: weights }), F('styles.fonts.body.lineHeight', 'range', 'Body line height', { min: 1.2, max: 2.1, step: 0.05 })])),
      group('Text sizes', make([F('styles.sizes.h1', 'range', 'Heading 1', { min: 2, max: 7, step: 0.1 }), F('styles.sizes.h2', 'range', 'Heading 2', { min: 1.5, max: 5, step: 0.1 }), F('styles.sizes.h3', 'range', 'Heading 3', { min: 1.1, max: 3.5, step: 0.05 }), F('styles.sizes.h4', 'range', 'Heading 4', { min: 1, max: 2.5, step: 0.05 }), F('styles.sizes.body', 'range', 'Body text', { min: 0.85, max: 1.5, step: 0.01 })])),
      group('Buttons', make([F('styles.fonts.button.family', 'font', 'Button font', { full: true }), F('styles.fonts.button.weight', 'select', 'Weight', { options: weights }), F('styles.fonts.button.transform', 'select', 'Case', { options: cases }),
        F('styles.fonts.button.size', 'range', 'Text size', { min: 0.7, max: 1.4, step: 0.01 }), F('styles.fonts.button.spacing', 'range', 'Letter spacing', { min: 0, max: 0.3, step: 0.01 }),
        F('styles.buttons.radius', 'range', 'Corner rounding', { min: 0, max: 40 }), F('styles.buttons.padX', 'range', 'Width padding', { min: 0.6, max: 3.5, step: 0.05 }), F('styles.buttons.padY', 'range', 'Height padding', { min: 0.3, max: 2, step: 0.05 }), F('styles.buttons.border', 'range', 'Outline thickness', { min: 1, max: 5 })])),
      group('Spacing & shapes', make([F('styles.layout.maxWidth', 'range', 'Content width', { min: 900, max: 1800, step: 10 }), F('styles.layout.sectionPad', 'range', 'Space above/below sections', { min: 0, max: 200 }), F('styles.layout.radius', 'range', 'Image & card rounding', { min: 0, max: 40 })])),
      h('h3', { class: 'side-h' }, 'General'),
      group('Site details', make([F('title', 'text', 'Site name'), F('description', 'textarea', 'Description for search engines'), F('favicon', 'image', 'Browser tab icon'), F('shareImage', 'image', 'Image shown when shared')])),
      group('Podcast feed', make([F('podcast.title', 'text', 'Podcast title'), F('podcast.description', 'textarea', 'Description'), F('podcast.author', 'text', 'Author'), F('podcast.image', 'image', 'Cover art (square, 1400px+)')])));
  }

  /* ---------- actions ---------- */
  function addSection(i) {
    const sec = R.newSection();
    change(() => { S.doc.sections.splice(i, 0, sec); S.sel = { sec: sec.id, blk: null }; });
    inspector(); tab = 'add'; sidebar(); Canvas().scrollTo(sec.id);
  }
  function addBlock(type) {
    let sec = curSection();
    if (!sec) { if (!S.doc.sections.length) S.doc.sections.push(R.newSection()); sec = S.doc.sections[S.doc.sections.length - 1]; }
    const b = R.newBlock(type);
    change(() => {
      b.d.y = sec.blocks.reduce((m, x) => Math.max(m, x.d.y + x.d.h), 0) + (sec.blocks.length ? 1 : 0);
      b.d.x = Math.max(0, Math.floor((24 - b.d.w) / 2));
      if (sec.mobileCustom) b.m = { x: 0, w: 8, h: Math.max(2, Math.round(b.d.h / 2)), y: sec.blocks.reduce((m, x) => Math.max(m, x.m ? x.m.y + x.m.h : 0), 0) + 1 };
      sec.blocks.push(b); S.sel = { sec: sec.id, blk: b.id };
    });
    inspector(); Canvas().scrollTo(b.id);
  }
  function blockAction(act) {
    const sec = curSection(), b = curBlock(); if (!b) return;
    const i = sec.blocks.indexOf(b);
    if (act === 'del') { change(() => sec.blocks.splice(i, 1)); select(sec.id, null); return; }
    if (act === 'dup') { const c = clone(b); c.id = R.uid(); c.d.y += 2; c.d.x = Math.min(24 - c.d.w, c.d.x + 1); change(() => { sec.blocks.push(c); S.sel.blk = c.id; }); inspector(); return; }
    const j = act === 'front' ? i + 1 : i - 1; if (j < 0 || j >= sec.blocks.length) return;
    change(() => { [sec.blocks[i], sec.blocks[j]] = [sec.blocks[j], sec.blocks[i]]; });
  }
  function key(e) {
    const mod = e.metaKey || e.ctrlKey, t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (mod && e.key === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? step(redo, undo) : step(undo, redo); return; }
    const b = curBlock(); if (!b || S.kind !== 'pages') { if (e.key === 'Escape') select(null, null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); blockAction('del'); }
    else if (mod && e.key === 'd') { e.preventDefault(); blockAction('dup'); }
    else if (e.key === 'Escape') select(S.sel.sec, null);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const g = S.mode === 'm' && b.m ? b.m : b.d, cols = g === b.m ? 8 : 24;
      change(() => { if (e.key === 'ArrowLeft') g.x = Math.max(0, g.x - 1); if (e.key === 'ArrowRight') g.x = Math.min(cols - g.w, g.x + 1); if (e.key === 'ArrowUp') g.y = Math.max(0, g.y - 1); if (e.key === 'ArrowDown') g.y += 1; }, 'nudge');
    }
  }

  /* ---------- documents ---------- */
  async function refreshLists() {
    const st = await api('GET', 'state');
    S.pages = st.pages; S.sermons = st.sermons; S.events = st.events; S.all = st.all;
    if (!S.site) S.site = st.site;
    $('#links').innerHTML = S.pages.map(p => `<option value="${p.slug === 'home' ? '/' : '/' + p.slug}">${R.esc(p.title)}</option>`).join('');
  }
  async function open(kind, slug) {
    if (S.dirty || S.siteDirty) await save();
    if (Canvas() && Canvas().isEditing()) Canvas().endEdit();
    S.doc = await api('GET', `doc?kind=${kind}&slug=${enc(slug)}`);
    S.kind = kind; S.slug = S.doc.slug; S.sel = { sec: null, blk: null }; undo = []; redo = []; S.dirty = false;
    location.hash = kind + '/' + slug;
    $('#doc-title').textContent = S.doc.title || '(untitled)';
    $('#view').href = kind === 'pages' ? (slug === 'home' ? '/' : '/' + slug + '/') : (kind === 'sermons' ? '/podcast/' : '/upcoming/') + slug + '/';
    setDirty(); Canvas().render(true); frame.contentWindow.scrollTo(0, 0); sidebar(); inspector();
  }
  async function createDoc(kind) {
    const title = prompt(kind === 'pages' ? 'Name of the new page:' : kind === 'sermons' ? 'Sermon title:' : 'Event name:'); if (!title) return;
    let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); const taken = S[kind].map(d => d.slug); let n = 2, base = slug;
    while (taken.includes(slug)) slug = base + '-' + n++;
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
    let doc;
    if (kind === 'pages') { const sec = R.newSection(), b = R.newBlock('text'); b.props.html = `<h1>${R.esc(title)}</h1><p>Start writing here.</p>`; b.d = { x: 3, y: 0, w: 18, h: 5 }; sec.blocks.push(b); doc = { title, slug, description: '', sections: [sec] }; }
    else if (kind === 'sermons') doc = { title, slug, date: today.slice(0, 10), speaker: '', scripture: '', description: '', audio: '', video: '', body: '' };
    else doc = { title, slug, start: today.slice(0, 10) + 'T09:00', end: '', allDay: false, location: '', image: '', summary: '', body: '', buttonLabel: '', buttonHref: '' };
    await api('PUT', `doc?kind=${kind}&slug=${enc(slug)}`, doc); await refreshLists(); await open(kind, slug);
    toast(kind === 'pages' ? 'Page created. Add it to the menu under Site › Navigation.' : 'Created');
  }
  async function removeDoc(kind, d) {
    if (!confirm(`Delete “${d.title}”? This cannot be undone (except by restoring an earlier published version).`)) return;
    await api('DELETE', `doc?kind=${kind}&slug=${enc(d.slug)}`); await refreshLists();
    if (S.kind === kind && S.slug === d.slug) { S.dirty = false; await open('pages', 'home'); } else sidebar();
  }
  async function save() {
    if (Canvas().isEditing()) Canvas().endEdit();
    try {
      if (S.siteDirty) { await api('PUT', 'site', S.site); S.siteDirty = false; }
      if (S.dirty) {
        const doc = await api('PUT', `doc?kind=${S.kind}&slug=${enc(S.doc.slug)}&old=${enc(S.slug)}`, S.doc);
        S.doc.slug = doc.slug; S.slug = doc.slug; S.dirty = false; $('#doc-title').textContent = S.doc.title;
        await refreshLists(); sidebar(); if (S.kind !== 'pages') Canvas().render(true);
      }
      setDirty(); toast('Saved');
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- dialogs ---------- */
  function modal(title, body, wide) {
    const close = () => bg.remove();
    const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(); } }, h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('div', { class: 'modal-h' }, h('h2', {}, title), h('button', { class: 'mini', onclick: close }, '✕')), body));
    document.body.append(bg); return close;
  }
  async function shrink(file) {   // keep uploads web-sized
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const bmp = await createImageBitmap(file).catch(() => null); if (!bmp || Math.max(bmp.width, bmp.height) <= 2400) return file;
    const k = 2400 / Math.max(bmp.width, bmp.height), c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(ok, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86));
  }
  async function mediaPicker(done) {
    const grid = h('div', { class: 'media-grid' }); let close;
    const load = async () => { grid.innerHTML = ''; (await api('GET', 'media')).forEach(m => grid.append(h('button', { onclick: () => { close(); done(m.url); } }, h('img', { src: m.url, loading: 'lazy' })))); };
    const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: async e => {
      let last = '';
      for (const file of e.target.files) { try { const r = await api('POST', `upload?kind=image&name=${enc(file.name)}`, await shrink(file), true); last = r.url; } catch (err) { toast(err.message, true); } }
      if (e.target.files.length === 1 && last) { close(); done(last); } else load();
    } });
    close = modal('Choose an image', h('div', {}, h('div', { class: 'modal-tools' }, h('button', { class: 'btn-p', onclick: () => pick.click() }, 'Upload from this Mac…'), pick, h('span', { class: 'hint' }, 'Large photos are resized automatically.')), grid), true);
    load();
  }
  function fontPicker(current, done) {
    const list = h('div', { class: 'font-list' }); let cat = '', q = '', close;
    const seen = new Set();
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting) return; const name = e.target.dataset.f; io.unobserve(e.target);
      if (!seen.has(name)) { seen.add(name); document.head.append(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}&text=${enc(name + ' The quick brown fox')}&display=swap` })); }
      e.target.style.fontFamily = `'${name}'`;
    }), { root: list });
    const draw = () => {
      list.innerHTML = '';
      fonts.filter(f => (!cat || f.c === cat) && (!q || f.f.toLowerCase().includes(q))).slice(0, 400).forEach(f => {
        const row = h('button', { class: 'font-row' + (f.f === current ? ' on' : ''), 'data-f': f.f, onclick: () => { close(); done(f); } }, h('span', { class: 'fr-n' }, f.f), h('span', { class: 'fr-c' }, f.c));
        list.append(row); io.observe(row);
      });
      if (!list.children.length) list.append(h('p', { class: 'hint' }, 'No fonts match.'));
    };
    const cats = ['', ...new Set(fonts.map(f => f.c))];
    close = modal('Choose a font', h('div', {}, h('div', { class: 'modal-tools' },
      h('input', { type: 'search', placeholder: `Search ${fonts.length} Google Fonts…`, oninput: e => { q = e.target.value.toLowerCase().trim(); draw(); } }),
      h('select', { onchange: e => { cat = e.target.value; draw(); } }, cats.map(c => h('option', { value: c }, c || 'All styles')))), list));
    draw();
  }
  async function publishDialog() {
    if (S.dirty || S.siteDirty) await save();
    const body = h('div', { class: 'pub' }, h('p', {}, 'Checking…')); modal('Publish', body);
    const draw = async () => {
      const [st, hist] = await Promise.all([api('GET', 'status'), api('GET', 'history')]);
      body.innerHTML = '';
      if (!st.remote) body.append(h('p', { class: 'warn' }, 'This Mac isn’t connected to GitHub yet, so publishing can’t put the site online. Your work is still saved here. Once the church GitHub account exists, ask Claude to “connect the website to GitHub”.'));
      const pending = st.changed + st.ahead;
      body.append(h('p', {}, pending ? `You have unpublished changes.` : 'Everything is published. No changes are waiting.'));
      const msg = h('input', { type: 'text', placeholder: 'What changed? (optional, for your history list)' });
      const go = h('button', { class: 'btn-p', onclick: async () => {
        go.disabled = true; go.textContent = 'Publishing…';
        try { const r = await api('POST', 'publish', { message: msg.value }); toast(r.ok ? 'Published! It will be live in about a minute.' : r.error, !r.ok); } catch (e) { toast(e.message, true); }
        draw();
      } }, 'Publish now');
      body.append(msg, go, h('h3', {}, 'History'));
      if (!hist.length) body.append(h('p', { class: 'hint' }, 'No versions yet. Each publish is kept here so you can go back.'));
      hist.forEach((v, i) => body.append(h('div', { class: 'hist' }, h('span', {}, new Date(v.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })), h('span', { class: 'hist-m' }, v.message),
        i === 0 ? h('span', { class: 'hint' }, 'current') : h('button', { class: 'btn-s', onclick: async () => {
          if (!confirm('Put the whole site back to how it was at this point? Later changes stay in the history, so you can undo this.')) return;
          try { const r = await api('POST', 'restore', { hash: v.hash }); toast(r.ok ? 'Restored and published.' : 'Restored on this Mac. ' + r.error, !r.ok); } catch (e) { toast(e.message, true); }
          S.site = null; await refreshLists(); S.dirty = false; await open(S.kind, S.slug).catch(() => open('pages', 'home')); draw();
        } }, 'Restore'))));
    };
    draw();
  }

  /* ---------- view size ---------- */
  function fit() {
    const stage = $('#stage'), availW = stage.clientWidth - 32, availH = stage.clientHeight - 24;
    const w = S.mode === 'm' ? 390 : Math.max(1280, availW), k = Math.min(1, availW / w);
    frame.style.width = w + 'px'; frame.style.height = (S.mode === 'm' ? Math.min(availH, 844) : availH) / k + 'px'; frame.style.transform = `scale(${k})`;
    frame.style.marginLeft = Math.max(0, (availW - w * k) / 2) + 'px';
    frame.classList.toggle('phone', S.mode === 'm');
  }
  function setMode(m) { S.mode = m; $('#m-d').classList.toggle('on', m === 'd'); $('#m-m').classList.toggle('on', m === 'm'); fit(); setTimeout(() => { Canvas().render(true); inspector(); }, 60); }

  /* ---------- start ---------- */
  const Editor = window.Editor = { S, ready: false, select, change, addSection, blockAction, key, save, refreshInspector: inspector,
    fontsHref: () => R.fontsHref(R.fontsUsed(S.site, S.doc && S.doc.sections ? [S.doc] : []), fonts),
    openSite(name) { tab = 'site'; openGroups['g:' + name] = true; sidebar(); const g = [...document.querySelectorAll('#side .grp')].find(x => x.firstChild.textContent === name); if (g) g.scrollIntoView({ block: 'start' }); },
    canvasReady: start };
  async function start() {
    if (Editor.started) return; Editor.started = true;
    await refreshLists();
    const [kind, ...rest] = decodeURIComponent(location.hash.slice(1)).split('/');
    await open(['pages', 'sermons', 'events'].includes(kind) && rest.length ? kind : 'pages', rest.join('/') || 'home').catch(() => open('pages', 'home'));
  }
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; sidebar(); }));
  $('#save').addEventListener('click', save); $('#publish').addEventListener('click', publishDialog);
  $('#undo').addEventListener('click', () => step(undo, redo)); $('#redo').addEventListener('click', () => step(redo, undo));
  $('#m-d').addEventListener('click', () => setMode('d')); $('#m-m').addEventListener('click', () => setMode('m'));
  $('#doc-title').addEventListener('click', () => { select(null, null); tab = 'pages'; sidebar(); });
  document.addEventListener('keydown', key);
  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', e => { if (S.dirty || S.siteDirty) { e.preventDefault(); e.returnValue = ''; } });
  fetch('/_api/fonts').then(r => r.json()).then(f => { fonts = f; }).catch(() => {});
  fit(); Editor.ready = true;
  if (frame.contentWindow.Canvas) start();
})();
