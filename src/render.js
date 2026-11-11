/* Shared renderer: turns content JSON into HTML.
   Used by build.js (Node) and by the editor canvas (browser), so the editor
   shows exactly what gets published. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Render = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 24, MCOLS = 8;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => 'b' + Math.random().toString(36).slice(2, 9);

  /* ---------- design system ---------- */
  const color = (site, v) => (v && site.styles.colors[v]) || v || '';
  const fontStack = f => `'${f.family}', ${f.fallback || 'sans-serif'}`;

  function themeCss(site) {
    const s = site.styles, c = s.colors, f = s.fonts;
    let css = ':root{';
    for (const k in c) css += `--c-${k}:${c[k]};`;
    css += `--font-h:${fontStack(f.heading)};--font-b:${fontStack(f.body)};--font-btn:${fontStack(f.button)};`;
    css += `--h-weight:${f.heading.weight};--h-spacing:${f.heading.spacing}em;--h-lh:${f.heading.lineHeight};--h-transform:${f.heading.transform};`;
    css += `--b-weight:${f.body.weight};--b-lh:${f.body.lineHeight};--b-size:${s.sizes.body}rem;`;
    css += `--btn-weight:${f.button.weight};--btn-transform:${f.button.transform};--btn-spacing:${f.button.spacing}em;--btn-size:${f.button.size}rem;`;
    css += `--h1:${s.sizes.h1}rem;--h2:${s.sizes.h2}rem;--h3:${s.sizes.h3}rem;--h4:${s.sizes.h4}rem;`;
    css += `--btn-radius:${s.buttons.radius}px;--btn-px:${s.buttons.padX}em;--btn-py:${s.buttons.padY}em;--btn-border:${s.buttons.border}px;`;
    css += `--maxw:${s.layout.maxWidth}px;--radius:${s.layout.radius}px;--sec-pad:${s.layout.sectionPad}px;}`;
    for (const name in s.themes) {
      const t = s.themes[name];
      css += `[data-theme="${name}"]{--bg:${color(site, t.bg)};--fg:${color(site, t.text)};--hd:${color(site, t.heading)};--ac:${color(site, t.accent)};--btn-bg:${color(site, t.buttonBg)};--btn-fg:${color(site, t.buttonText)};}`;
    }
    return css;
  }

  /* Collect every font family in use so the build can request them. */
  function fontsUsed(site, docs) {
    const set = new Set([site.styles.fonts.heading.family, site.styles.fonts.body.family, site.styles.fonts.button.family]);
    (docs || []).forEach(d => (d.sections || []).forEach(s => s.blocks.forEach(b => { if (b.style && b.style.font) set.add(b.style.font); })));
    return [...set];
  }
  function fontsHref(families, catalog) {
    const parts = families.map(name => {
      const m = (catalog || []).find(x => x.f === name); if (!m) return null;
      let ws = m.v ? [400, 500, 600, 700].filter(w => w >= m.v[0] && w <= m.v[1]) : m.w.filter(w => [300, 400, 500, 600, 700].includes(w));
      if (!ws.length) ws = [m.w[0]];
      const fam = name.replace(/ /g, '+');
      return m.i ? `family=${fam}:ital,wght@${ws.map(w => '0,' + w).concat(ws.map(w => '1,' + w)).join(';')}` : `family=${fam}:wght@${ws.join(';')}`;
    }).filter(Boolean);
    return parts.length ? `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap` : '';
  }

  /* ---------- helpers ---------- */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function parts(s) {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(s || ''); if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: m[4] == null ? null : +m[4], mi: +(m[5] || 0), dow: dt.getUTCDay() };
  }
  function fmtDate(s, short) {
    const p = parts(s); if (!p) return '';
    return short ? `${MONTHS[p.mo].slice(0, 3)} ${p.d}, ${p.y}` : `${DAYS[p.dow]}, ${MONTHS[p.mo]} ${p.d}, ${p.y}`;
  }
  function fmtTime(s) {
    const p = parts(s); if (!p || p.h == null) return '';
    return `${p.h % 12 || 12}:${String(p.mi).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
  }
  function fmtWhen(ev) {
    let out = fmtDate(ev.start); const t = fmtTime(ev.start); if (t && !ev.allDay) out += ' · ' + t;
    if (ev.end) {
      if (ev.end.slice(0, 10) !== ev.start.slice(0, 10)) out += ' – ' + fmtDate(ev.end) + (ev.allDay ? '' : ' · ' + fmtTime(ev.end));
      else if (!ev.allDay && fmtTime(ev.end)) out += ' – ' + fmtTime(ev.end);
    }
    return out;
  }
  const nowLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const upcoming = (events) => events.filter(e => (e.end || e.start || '').slice(0, 10) >= nowLocal().slice(0, 10)).sort((a, b) => a.start < b.start ? -1 : 1);
  const latestSermons = (sermons) => sermons.slice().sort((a, b) => a.date < b.date ? 1 : -1);

  function videoEmbed(url) {
    let m = /[?&]list=([\w-]+)/.exec(url || '');
    if (m && !/[?&]v=/.test(url)) return `https://www.youtube-nocookie.com/embed/videoseries?list=${m[1]}`;
    m = /(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([\w-]{11})/.exec(url || '');
    if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0`;
    m = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url || '');
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
    return '';
  }
  const audioUrl = (site, file) => !file ? '' : /^https?:/.test(file) ? file : (site.podcast.audioBase || '/audio/') + file;

  const ICONS = {
    facebook: 'M13.5 22v-8h2.7l.4-3.2h-3.1V8.7c0-.9.3-1.5 1.6-1.5h1.7V4.3c-.3 0-1.3-.1-2.5-.1-2.4 0-4.1 1.5-4.1 4.2v2.4H7.5V14h2.7v8z',
    instagram: 'M7 2h10a5 5 0 015 5v10a5 5 0 01-5 5H7a5 5 0 01-5-5V7a5 5 0 015-5zm0 2a3 3 0 00-3 3v10a3 3 0 003 3h10a3 3 0 003-3V7a3 3 0 00-3-3H7zm5 3.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9zm0 2a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM17.5 5.5a1 1 0 110 2 1 1 0 010-2z',
    youtube: 'M3 7a3 3 0 013-3h12a3 3 0 013 3v10a3 3 0 01-3 3H6a3 3 0 01-3-3V7zm7 1.5v7l6-3.5z',
    spotify: 'M12 2a10 10 0 110 20 10 10 0 010-20zM7 8.5h10v1.8H7zM8 12h8v1.6H8zM9 15.2h6v1.4H9z',
    email: 'M3 5h18a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm1 3.2V17h16V8.2l-8 5.6-8-5.6z',
    link: 'M9 7H7a5 5 0 000 10h2v-2H7a3 3 0 010-6h2V7zm6 0v2h2a3 3 0 010 6h-2v2h2a5 5 0 000-10h-2zM8 11h8v2H8z',
    file: 'M6 2h8l5 5v14a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm7 1.5V8h4.5zM8 12h8v1.5H8zm0 3.5h8V17H8z'
  };
  const icon = n => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${ICONS[n] || ICONS.link}"/></svg>`;
  const btn = (label, href, variant, size) => label ? `<a class="btn btn-${variant || 'primary'}${size ? ' btn-' + size : ''}" href="${esc(href || '#')}"${/^https?:/.test(href || '') ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>` : '';
  const placeholder = (ctx, text) => ctx.editing ? `<div class="ph">${esc(text)}</div>` : '';
  const img = (src, alt, extra) => `<img src="${esc(src)}" alt="${esc(alt || '')}" loading="lazy" decoding="async"${extra || ''}>`;

  /* ---------- field helpers for the editor inspector ---------- */
  const F = (k, t, label, o) => Object.assign({ k, t, label }, o || {});
  const VARIANTS = [['primary', 'Solid'], ['outline', 'Outline'], ['text', 'Text link']];

  /* ---------- block types ---------- */
  const BLOCKS = {
    text: {
      label: 'Text', w: 10, h: 4, props: { html: '<h2>Heading</h2><p>Double-click to edit this text.</p>' },
      fields: [],
      render: b => `<div class="rt">${b.props.html || ''}</div>`
    },
    image: {
      label: 'Image', w: 8, h: 10, fill: true, props: { src: '', alt: '', fit: 'cover', href: '', caption: '', focus: '50% 50%' },
      fields: [F('src', 'image', 'Image'), F('alt', 'text', 'Description (for screen readers)'), F('fit', 'select', 'Fit', { options: [['cover', 'Fill the box (crop)'], ['contain', 'Show whole image']] }),
        F('focus', 'select', 'Focal point', { options: [['50% 50%', 'Center'], ['50% 0%', 'Top'], ['50% 100%', 'Bottom'], ['0% 50%', 'Left'], ['100% 50%', 'Right'], ['50% 25%', 'Upper'], ['50% 75%', 'Lower']] }),
        F('href', 'url', 'Link when clicked'), F('caption', 'text', 'Caption')],
      render: (b, ctx) => {
        const p = b.props; if (!p.src) return placeholder(ctx, 'Image: choose a picture');
        const im = img(p.src, p.alt, ` style="object-fit:${p.fit || 'cover'};object-position:${p.focus || '50% 50%'}"`);
        return `<figure class="b-img">${p.href ? `<a href="${esc(p.href)}">${im}</a>` : im}${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`;
      }
    },
    button: {
      label: 'Button', w: 5, h: 2, props: { label: 'Learn More', href: '', variant: 'primary', size: '', align: 'left' },
      fields: [F('label', 'text', 'Label'), F('href', 'url', 'Link'), F('variant', 'select', 'Style', { options: VARIANTS }),
        F('size', 'select', 'Size', { options: [['sm', 'Small'], ['', 'Medium'], ['lg', 'Large']] }), F('align', 'select', 'Position', { options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['stretch', 'Full width']] })],
      render: b => `<div class="b-btn al-${b.props.align || 'left'}">${btn(b.props.label, b.props.href, b.props.variant, b.props.size)}</div>`
    },
    video: {
      label: 'Video', w: 14, h: 13, fill: true, props: { url: '', title: '' },
      fields: [F('url', 'url', 'YouTube or Vimeo link'), F('title', 'text', 'Title (for screen readers)')],
      render: (b, ctx) => {
        const src = videoEmbed(b.props.url); if (!src) return placeholder(ctx, 'Video: paste a YouTube or Vimeo link');
        return `<div class="b-video"><iframe src="${src}" title="${esc(b.props.title || 'Video')}" loading="lazy" allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
      }
    },
    gallery: {
      label: 'Gallery', w: 24, h: 12, props: { mode: 'grid', cols: 3, ratio: '4/3', images: [] },
      fields: [F('mode', 'select', 'Layout', { options: [['grid', 'Grid'], ['slides', 'Slideshow']] }), F('cols', 'range', 'Columns (grid)', { min: 1, max: 6 }),
        F('ratio', 'select', 'Image shape', { options: [['4/3', 'Landscape'], ['1/1', 'Square'], ['3/4', 'Portrait'], ['16/9', 'Wide']] }),
        F('images', 'list', 'Images', { titleKey: 'alt', blank: { src: '', alt: '' }, item: [F('src', 'image', 'Image'), F('alt', 'text', 'Description')] })],
      render: (b, ctx) => {
        const p = b.props, ims = (p.images || []).filter(i => i.src); if (!ims.length) return placeholder(ctx, 'Gallery: add images');
        if (p.mode === 'slides') return `<div class="b-slides" data-slides style="--ratio:${p.ratio}">${ims.map((i, n) => `<div class="slide${n ? '' : ' on'}">${img(i.src, i.alt)}</div>`).join('')}<button class="sl-prev" aria-label="Previous">‹</button><button class="sl-next" aria-label="Next">›</button></div>`;
        return `<div class="b-gal" style="--cols:${p.cols || 3};--ratio:${p.ratio}">${ims.map(i => img(i.src, i.alt)).join('')}</div>`;
      }
    },
    accordion: {
      label: 'Accordion', w: 14, h: 8, props: { items: [{ title: 'Question or heading', html: '<p>Details go here.</p>' }] },
      fields: [F('items', 'list', 'Items', { titleKey: 'title', blank: { title: 'New item', html: '<p></p>' }, item: [F('title', 'text', 'Heading'), F('html', 'rich', 'Content')] })],
      render: b => `<div class="b-acc">${(b.props.items || []).map(i => `<details><summary>${esc(i.title)}</summary><div class="rt">${i.html || ''}</div></details>`).join('')}</div>`
    },
    cards: {
      label: 'Cards', w: 24, h: 14, props: { cols: 3, style: 'card', ratio: '4/3', items: [{ image: '', title: 'Card title', html: '<p>Card text.</p>', label: 'Learn More', href: '' }] },
      fields: [F('cols', 'range', 'Columns', { min: 1, max: 5 }), F('style', 'select', 'Look', { options: [['card', 'Boxed card'], ['plain', 'No box']] }),
        F('ratio', 'select', 'Image shape', { options: [['4/3', 'Landscape'], ['1/1', 'Square'], ['3/4', 'Portrait'], ['16/9', 'Wide']] }),
        F('items', 'list', 'Cards', { titleKey: 'title', blank: { image: '', title: 'Card title', html: '<p></p>', label: '', href: '' }, item: [F('image', 'image', 'Image'), F('title', 'text', 'Title'), F('html', 'rich', 'Text'), F('label', 'text', 'Button label'), F('href', 'url', 'Button link')] })],
      render: b => {
        const p = b.props;
        return `<div class="b-cards st-${p.style || 'card'}" style="--cols:${p.cols || 3};--ratio:${p.ratio || '4/3'}">${(p.items || []).map(i => `<article class="card">${i.image ? `<div class="card-img">${img(i.image, i.title)}</div>` : ''}<div class="card-body"><h3>${esc(i.title)}</h3><div class="rt">${i.html || ''}</div>${btn(i.label, i.href, 'text')}</div></article>`).join('')}</div>`;
      }
    },
    staff: {
      label: 'People', w: 24, h: 14, props: { cols: 4, shape: 'round', items: [{ image: '', name: 'Name', role: 'Role', html: '', email: '' }] },
      fields: [F('cols', 'range', 'Columns', { min: 1, max: 6 }), F('shape', 'select', 'Photo shape', { options: [['round', 'Circle'], ['square', 'Rounded square'], ['portrait', 'Portrait']] }),
        F('items', 'list', 'People', { titleKey: 'name', blank: { image: '', name: 'Name', role: '', html: '', email: '' }, item: [F('image', 'image', 'Photo'), F('name', 'text', 'Name'), F('role', 'text', 'Title or role'), F('html', 'rich', 'Bio'), F('email', 'text', 'Email address')] })],
      render: b => {
        const p = b.props;
        return `<div class="b-staff sh-${p.shape || 'round'}" style="--cols:${p.cols || 4}">${(p.items || []).map(i => `<article class="person"><div class="person-img">${i.image ? img(i.image, i.name) : ''}</div><h3>${esc(i.name)}</h3>${i.role ? `<p class="role">${esc(i.role)}</p>` : ''}${i.html ? `<div class="rt">${i.html}</div>` : ''}${i.email ? `<a class="btn btn-text" href="mailto:${esc(i.email)}">Email ${esc((i.name || '').split(' ')[0])}</a>` : ''}</article>`).join('')}</div>`;
      }
    },
    downloads: {
      label: 'File downloads', w: 12, h: 6, props: { items: [] },
      fields: [F('items', 'list', 'Files', { titleKey: 'label', blank: { label: 'Document', file: '' }, item: [F('label', 'text', 'Label'), F('file', 'file', 'File')] })],
      render: (b, ctx) => (b.props.items || []).length ? `<ul class="b-files">${b.props.items.map(i => `<li><a href="${esc(i.file)}" target="_blank" rel="noopener">${icon('file')}<span>${esc(i.label)}</span></a></li>`).join('')}</ul>` : placeholder(ctx, 'Downloads: add files')
    },
    divider: {
      label: 'Divider line', w: 24, h: 1, props: { width: 100, thickness: 1 },
      fields: [F('width', 'range', 'Width %', { min: 5, max: 100 }), F('thickness', 'range', 'Thickness', { min: 1, max: 10 })],
      render: b => `<hr class="b-hr" style="width:${b.props.width || 100}%;border-top-width:${b.props.thickness || 1}px">`
    },
    shape: {
      label: 'Shape', w: 8, h: 8, fill: true, decorative: true, props: { kind: 'rect', fill: 'accent', radius: 12, opacity: 100, borderColor: '', borderWidth: 0 },
      fields: [F('kind', 'select', 'Shape', { options: [['rect', 'Rectangle'], ['ellipse', 'Circle / oval'], ['line', 'Line']] }), F('fill', 'color', 'Fill color'), F('radius', 'range', 'Corner rounding', { min: 0, max: 80 }),
        F('opacity', 'range', 'Opacity %', { min: 5, max: 100 }), F('borderColor', 'color', 'Outline color'), F('borderWidth', 'range', 'Outline width', { min: 0, max: 12 })],
      render: (b, ctx) => {
        const p = b.props, fill = color(ctx.site, p.fill) || 'transparent';
        if (p.kind === 'line') return `<div class="b-shape line" style="border-top:${Math.max(1, p.borderWidth || 2)}px solid ${color(ctx.site, p.borderColor) || fill};opacity:${(p.opacity || 100) / 100}"></div>`;
        return `<div class="b-shape" style="background:${fill};border-radius:${p.kind === 'ellipse' ? '50%' : (p.radius || 0) + 'px'};opacity:${(p.opacity || 100) / 100};${p.borderWidth ? `border:${p.borderWidth}px solid ${color(ctx.site, p.borderColor)}` : ''}"></div>`;
      }
    },
    events: {
      label: 'Event list', w: 24, h: 10, props: { count: 3, layout: 'cards', empty: 'No upcoming events right now. Check back soon!' },
      fields: [F('count', 'range', 'How many to show', { min: 1, max: 12 }), F('layout', 'select', 'Layout', { options: [['cards', 'Cards'], ['list', 'List']] }), F('empty', 'text', 'Message when there are none')],
      render: (b, ctx) => {
        const evs = upcoming(ctx.events || []).slice(0, b.props.count || 3);
        if (!evs.length) return `<p class="b-empty">${esc(b.props.empty)}</p>`;
        return `<div class="b-events ly-${b.props.layout || 'cards'}">${evs.map(e => `<a class="event" href="/upcoming/${esc(e.slug)}/" data-end="${esc((e.end || e.start).slice(0, 10))}">${e.image ? `<div class="event-img">${img(e.image, '')}</div>` : ''}<div class="event-body"><p class="event-date">${esc(fmtWhen(e))}</p><h3>${esc(e.title)}</h3>${e.location ? `<p class="event-loc">${esc(e.location)}</p>` : ''}${e.summary ? `<p>${esc(e.summary)}</p>` : ''}</div></a>`).join('')}</div>`;
      }
    },
    sermons: {
      label: 'Sermon list', w: 24, h: 10, props: { count: 5, layout: 'list' },
      fields: [F('count', 'range', 'How many to show', { min: 1, max: 100 }), F('layout', 'select', 'Layout', { options: [['list', 'List'], ['cards', 'Cards'], ['featured', 'Latest sermon with player']] })],
      render: (b, ctx) => {
        const all = latestSermons(ctx.sermons || []), p = b.props;
        if (!all.length) return `<p class="b-empty">Sermons will appear here.</p>`;
        if (p.layout === 'featured') {
          const s = all[0], v = videoEmbed(s.video);
          return `<div class="b-sermon-feat"><p class="eyebrow">${esc(fmtDate(s.date))}${s.speaker ? ' · ' + esc(s.speaker) : ''}</p><h3><a href="/podcast/${esc(s.slug)}/">${esc(s.title)}</a></h3>${s.description ? `<p>${esc(s.description)}</p>` : ''}${s.audio ? `<audio controls preload="none" src="${esc(audioUrl(ctx.site, s.audio))}"></audio>` : v ? `<div class="b-video"><iframe src="${v}" title="${esc(s.title)}" loading="lazy" allowfullscreen></iframe></div>` : ''}</div>`;
        }
        return `<div class="b-sermons ly-${p.layout || 'list'}">${all.slice(0, p.count || 5).map(s => `<a class="sermon" href="/podcast/${esc(s.slug)}/"><p class="eyebrow">${esc(fmtDate(s.date, true))}${s.speaker ? ' · ' + esc(s.speaker) : ''}</p><h3>${esc(s.title)}</h3>${s.description ? `<p>${esc(s.description)}</p>` : ''}</a>`).join('')}</div>`;
      }
    },
    social: {
      label: 'Social links', w: 8, h: 2, props: { align: 'left', labels: false },
      fields: [F('align', 'select', 'Position', { options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] }), F('labels', 'toggle', 'Show names as buttons')],
      render: (b, ctx) => socialLinks(ctx.site, b.props.align, b.props.labels)
    },
    map: {
      label: 'Map', w: 12, h: 12, fill: true, props: { query: '5508 Telegraph Road, St. Louis, MO 63129', zoom: 14 },
      fields: [F('query', 'text', 'Address or place'), F('zoom', 'range', 'Zoom', { min: 8, max: 19 })],
      render: b => `<div class="b-map"><iframe src="https://www.google.com/maps?q=${encodeURIComponent(b.props.query || '')}&z=${b.props.zoom || 14}&output=embed" title="Map" loading="lazy"></iframe></div>`
    },
    gform: {
      label: 'Google Form', w: 14, h: 28, fill: true, props: { url: '', label: 'Open the form' },
      fields: [F('url', 'url', 'Google Form link (use Send › link, full docs.google.com address)'), F('label', 'text', 'Fallback button label')],
      render: (b, ctx) => {
        const u = b.props.url || ''; if (!u) return placeholder(ctx, 'Google Form: paste the form link');
        if (!/docs\.google\.com\/forms/.test(u)) return `<div class="b-btn al-left">${btn(b.props.label, u, 'primary')}</div>`;
        return `<div class="b-form"><iframe src="${esc(u.replace(/\/(viewform|edit).*$/, '/viewform') + '?embedded=true')}" title="Form" loading="lazy">Loading…</iframe></div>`;
      }
    },
    embed: {
      label: 'Custom code / embed', w: 12, h: 8, props: { html: '' },
      fields: [F('html', 'code', 'HTML or embed code')],
      render: (b, ctx) => b.props.html ? `<div class="b-embed">${b.props.html}</div>` : placeholder(ctx, 'Custom embed: paste code')
    }
  };

  /* Style overrides available on every block. */
  const STYLE_FIELDS = [
    F('color', 'color', 'Text color'), F('bg', 'color', 'Background'), F('font', 'font', 'Font'),
    F('size', 'range', 'Text size %', { min: 60, max: 300, step: 5, def: 100 }), F('align', 'select', 'Text alignment', { options: [['', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']] }),
    F('valign', 'select', 'Vertical position', { options: [['', 'Top'], ['center', 'Middle'], ['end', 'Bottom']] }),
    F('pad', 'range', 'Inner padding', { min: 0, max: 80, def: 0 }), F('radius', 'range', 'Corner rounding', { min: 0, max: 80, def: 0 }),
    F('shadow', 'select', 'Shadow', { options: [['', 'None'], ['sm', 'Soft'], ['lg', 'Strong']] }),
    F('btnBg', 'color', 'Button color'), F('btnFg', 'color', 'Button text color'), F('btnRadius', 'range', 'Button rounding', { min: 0, max: 40, def: -1 })
  ];
  const SECTION_FIELDS = [
    F('theme', 'theme', 'Color theme'), F('full', 'toggle', 'Full-width (edge to edge)'),
    F('bgColor', 'color', 'Background color (overrides theme)'), F('bgImage', 'image', 'Background image'),
    F('bgFocus', 'select', 'Image position', { options: [['50% 50%', 'Center'], ['50% 0%', 'Top'], ['50% 100%', 'Bottom'], ['50% 25%', 'Upper'], ['50% 75%', 'Lower']] }),
    F('bgVideo', 'url', 'Background video (.mp4 link)'), F('gradient', 'text', 'Gradient (CSS, e.g. linear-gradient(135deg,#00624f,#0a3d33))'),
    F('overlay', 'color', 'Overlay color'), F('overlayOpacity', 'range', 'Overlay strength %', { min: 0, max: 95, def: 0 }),
    F('padTop', 'range', 'Space above', { min: 0, max: 240, def: -1 }), F('padBottom', 'range', 'Space below', { min: 0, max: 240, def: -1 }),
    F('minHeight', 'range', 'Minimum height (% of screen)', { min: 0, max: 100, def: 0 }), F('anchor', 'text', 'Anchor name (for #links)')
  ];

  function blockStyle(site, st) {
    if (!st) return '';
    let s = '';
    if (st.color) s += `color:${color(site, st.color)};--fg:${color(site, st.color)};--hd:${color(site, st.color)};`;
    if (st.bg) s += `background:${color(site, st.bg)};`;
    if (st.font) s += `font-family:'${st.font}',sans-serif;--font-h:'${st.font}',sans-serif;--font-b:'${st.font}',sans-serif;`;
    if (st.size && st.size != 100) s += `font-size:${st.size}%;`;
    if (st.align) s += `text-align:${st.align};`;
    if (st.valign) s += `display:flex;flex-direction:column;justify-content:${st.valign};`;
    if (st.pad > 0) s += `padding:${st.pad}px;`;
    if (st.radius > 0) s += `border-radius:${st.radius}px;overflow:hidden;`;
    if (st.shadow) s += `box-shadow:${st.shadow === 'lg' ? '0 18px 50px rgba(0,0,0,.22)' : '0 4px 18px rgba(0,0,0,.10)'};`;
    if (st.btnBg) s += `--btn-bg:${color(site, st.btnBg)};--ac:${color(site, st.btnBg)};`;
    if (st.btnFg) s += `--btn-fg:${color(site, st.btnFg)};`;
    if (st.btnRadius >= 0 && st.btnRadius !== '' && st.btnRadius != null) s += `--btn-radius:${st.btnRadius}px;`;
    return s;
  }

  function mobileOrder(blocks) {
    const idx = blocks.map((b, i) => i).sort((a, b) => (blocks[a].d.y - blocks[b].d.y) || (blocks[a].d.x - blocks[b].d.x));
    const order = []; idx.forEach((bi, o) => order[bi] = o); return order;
  }

  function renderBlock(b, i, order, ctx) {
    const def = BLOCKS[b.type]; if (!def) return '';
    const d = b.d, m = b.m;
    let st = `--x:${d.x + 1};--y:${d.y + 1};--w:${d.w};--h:${d.h};--o:${order};z-index:${i + 1};--ar:${(d.w * 50 / (d.h * 24)).toFixed(3)};`;
    if (m) st += `--mx:${m.x + 1};--my:${m.y + 1};--mw:${m.w};--mh:${m.h};`;
    const cls = `blk blk-${b.type}${def.fill ? ' fill' : ''}${def.decorative ? ' deco' : ''}${b.hideMobile ? ' hide-m' : ''}`;
    return `<div class="${cls}" data-id="${b.id}" style="${st}"><div class="blk-in" style="${blockStyle(ctx.site, b.style)}">${def.render(b, ctx)}</div></div>`;
  }

  function renderSection(sec, ctx) {
    const order = mobileOrder(sec.blocks);
    let st = '', bg = '';
    if (sec.bgColor) st += `--bg:${color(ctx.site, sec.bgColor)};`;
    if (sec.padTop >= 0 && sec.padTop != null && sec.padTop !== '') st += `--pt:${sec.padTop}px;`;
    if (sec.padBottom >= 0 && sec.padBottom != null && sec.padBottom !== '') st += `--pb:${sec.padBottom}px;`;
    if (sec.minHeight > 0) st += `min-height:${sec.minHeight}vh;`;
    if (sec.gradient) bg += `<div class="sec-bg" style="background:${esc(sec.gradient)}"></div>`;
    if (sec.bgImage) bg += `<div class="sec-bg" style="background-image:url('${esc(sec.bgImage)}');background-position:${sec.bgFocus || '50% 50%'}"></div>`;
    if (sec.bgVideo && !ctx.editing) bg += `<video class="sec-bg" src="${esc(sec.bgVideo)}" autoplay muted loop playsinline></video>`;
    if (sec.overlayOpacity > 0) bg += `<div class="sec-bg" style="background:${color(ctx.site, sec.overlay) || '#000'};opacity:${sec.overlayOpacity / 100}"></div>`;
    return `<section class="sec${sec.full ? ' full' : ''}" data-id="${sec.id}" data-theme="${esc(sec.theme || 'white')}"${sec.mobileCustom ? ' data-mc' : ''}${sec.anchor ? ` id="${esc(sec.anchor)}"` : ''} style="${st}">${bg}<div class="sec-grid">${sec.blocks.map((b, i) => renderBlock(b, i, order[i], ctx)).join('')}</div></section>`;
  }

  const renderSections = (doc, ctx) => (doc.sections || []).map(s => renderSection(s, ctx)).join('');

  /* ---------- sermon & event page templates ---------- */
  function renderSermon(s, ctx) {
    const v = videoEmbed(s.video), all = latestSermons(ctx.sermons || []), i = all.findIndex(x => x.slug === s.slug);
    const newer = all[i - 1], older = all[i + 1];
    return `<section class="sec" data-theme="white"><article class="doc"><p><a class="btn btn-text" href="/podcast/">← All sermons</a></p><p class="eyebrow">${esc(fmtDate(s.date))}${s.speaker ? ' · ' + esc(s.speaker) : ''}${s.scripture ? ' · ' + esc(s.scripture) : ''}</p><h1>${esc(s.title)}</h1>${s.description ? `<p class="lead">${esc(s.description)}</p>` : ''}${s.audio ? `<audio controls preload="metadata" src="${esc(audioUrl(ctx.site, s.audio))}"></audio>` : ''}${v ? `<div class="b-video doc-video"><iframe src="${v}" title="${esc(s.title)}" loading="lazy" allowfullscreen></iframe></div>` : ''}${s.body ? `<div class="rt">${s.body}</div>` : ''}<nav class="doc-nav">${older ? `<a href="/podcast/${esc(older.slug)}/">← ${esc(older.title)}</a>` : '<span></span>'}${newer ? `<a href="/podcast/${esc(newer.slug)}/">${esc(newer.title)} →</a>` : ''}</nav></article></section>`;
  }
  function renderEvent(e, ctx) {
    return `<section class="sec" data-theme="white"><article class="doc"><p><a class="btn btn-text" href="/events/">← All events</a></p>${e.image ? `<div class="doc-img">${img(e.image, e.title)}</div>` : ''}<p class="eyebrow">${esc(fmtWhen(e))}</p><h1>${esc(e.title)}</h1>${e.location ? `<p class="lead">${esc(e.location)}</p>` : ''}${e.body ? `<div class="rt">${e.body}</div>` : ''}${e.buttonLabel ? `<p>${btn(e.buttonLabel, e.buttonHref, 'primary')}</p>` : ''}</article></section>`;
  }
  const DOC_FIELDS = {
    pages: [F('title', 'text', 'Page title'), F('slug', 'text', 'Web address (after sp4u.org/)'), F('description', 'textarea', 'Search-engine description'), F('hidden', 'toggle', 'Hide from search engines')],
    sermons: [F('title', 'text', 'Sermon title'), F('date', 'date', 'Date preached'), F('speaker', 'text', 'Speaker'), F('scripture', 'text', 'Scripture reference'), F('description', 'textarea', 'Summary'),
      F('audio', 'audio', 'Audio recording (MP3)'), F('video', 'url', 'YouTube link (optional)'), F('body', 'rich', 'Notes (optional)'), F('slug', 'text', 'Web address (after /podcast/)')],
    events: [F('title', 'text', 'Event name'), F('start', 'datetime', 'Starts'), F('end', 'datetime', 'Ends (optional)'), F('allDay', 'toggle', 'All-day event'), F('location', 'text', 'Location'),
      F('image', 'image', 'Image'), F('summary', 'textarea', 'Short summary (shown in lists)'), F('body', 'rich', 'Full description'), F('buttonLabel', 'text', 'Button label'), F('buttonHref', 'url', 'Button link'), F('slug', 'text', 'Web address (after /upcoming/)')]
  };

  /* ---------- site chrome ---------- */
  function socialLinks(site, align, labels) {
    return `<div class="b-social al-${align || 'left'}">${(site.social || []).filter(s => s.href).map(s => labels ? `<a class="btn btn-outline" href="${esc(s.href)}" target="_blank" rel="noopener">${icon(s.type)} ${esc(s.label || s.type)}</a>` : `<a href="${esc(s.href)}" target="_blank" rel="noopener" aria-label="${esc(s.label || s.type)}">${icon(s.type)}</a>`).join('')}</div>`;
  }
  const ext = h => /^https?:/.test(h || '') ? ' target="_blank" rel="noopener"' : '';
  function renderHeader(site) {
    const h = site.header || {};
    const nav = (site.nav || []).map(n => n.children && n.children.length
      ? `<li class="has-sub"><button type="button" aria-expanded="false">${esc(n.label)}<span class="caret"></span></button><ul>${n.children.map(c => `<li><a href="${esc(c.href)}"${ext(c.href)}>${esc(c.label)}</a></li>`).join('')}</ul></li>`
      : `<li><a href="${esc(n.href)}"${ext(n.href)}>${esc(n.label)}</a></li>`).join('');
    const a = site.announcement || {};
    const bar = a.enabled && a.text ? `<div class="announce" data-theme="${esc(a.theme || 'dark')}" data-announce="${esc(a.text.length + '-' + a.text.slice(0, 12))}"><p>${a.href ? `<a href="${esc(a.href)}">${esc(a.text)}</a>` : esc(a.text)}</p><button aria-label="Dismiss">×</button></div>` : '';
    return `${bar}<header class="site-head${h.sticky ? ' sticky' : ''}" data-theme="${esc(h.theme || 'accent')}"><a class="skip" href="#main">Skip to content</a><div class="head-in"><a class="logo" href="/">${site.logo ? `<img src="${esc(site.logo)}" alt="${esc(site.title)}" style="height:${h.logoHeight || 52}px">` : esc(site.title)}</a><button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button><nav class="site-nav" aria-label="Main"><ul>${nav}</ul>${h.ctaLabel ? btn(h.ctaLabel, h.ctaHref, 'primary', 'sm') : ''}</nav></div></header>`;
  }
  function renderFooter(site) {
    const f = site.footer || {};
    return `<footer class="site-foot" data-theme="${esc(f.theme || 'dark')}"><div class="foot-in">${(f.columns || []).map(c => `<div class="foot-col"><h2>${esc(c.title)}</h2><div class="rt">${c.html || ''}</div></div>`).join('')}<div class="foot-col foot-social">${f.showSocial !== false ? `<h2>${esc(f.socialTitle || 'Follow Us')}</h2>${socialLinks(site, 'left')}` : ''}${f.badge ? `<a class="foot-badge" href="${esc(f.badgeHref || '#')}"${ext(f.badgeHref)}><img src="${esc(f.badge)}" alt="${esc(f.badgeAlt || '')}" loading="lazy"></a>` : ''}</div></div>${f.note ? `<p class="foot-note">${esc(f.note).replace('{year}', new Date().getFullYear())}</p>` : ''}</footer>`;
  }

  /* Full HTML document. kind: pages | sermons | events */
  function renderDocument(kind, doc, ctx) {
    const site = ctx.site;
    const main = kind === 'sermons' ? renderSermon(doc, ctx) : kind === 'events' ? renderEvent(doc, ctx) : renderSections(doc, ctx);
    const isHome = kind === 'pages' && doc.slug === 'home';
    const title = isHome ? site.title : `${doc.title} — ${site.title}`;
    const path = kind === 'sermons' ? `/podcast/${doc.slug}/` : kind === 'events' ? `/upcoming/${doc.slug}/` : isHome ? '/' : `/${doc.slug}/`;
    const desc = doc.description || doc.summary || site.description || '';
    const image = doc.image || site.shareImage || '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${doc.hidden ? '<meta name="robots" content="noindex">' : ''}<link rel="canonical" href="${esc(site.url + path)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(site.url + path)}">${image ? `<meta property="og:image" content="${esc(site.url + image)}">` : ''}${site.favicon ? `<link rel="icon" href="${esc(site.favicon)}">` : ''}<link rel="alternate" type="application/rss+xml" title="${esc(site.podcast.title)}" href="/podcast/feed.xml">${ctx.fontsHref ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(ctx.fontsHref)}">` : ''}<link rel="stylesheet" href="/assets/site.css?v=${ctx.version || 1}"><style id="theme">${themeCss(site)}</style></head><body data-theme="white">${renderHeader(site)}<main id="main">${main}</main>${renderFooter(site)}<script src="/assets/site.js?v=${ctx.version || 1}" defer></script></body></html>`;
  }

  function newBlock(type) {
    const def = BLOCKS[type];
    return { id: uid(), type, d: { x: 0, y: 0, w: def.w, h: def.h }, m: null, props: JSON.parse(JSON.stringify(def.props)), style: {} };
  }
  const newSection = () => ({ id: uid(), theme: 'white', blocks: [] });

  return { COLS, MCOLS, BLOCKS, STYLE_FIELDS, SECTION_FIELDS, DOC_FIELDS, esc, uid, color, themeCss, fontsUsed, fontsHref, renderSection, renderSections, renderBlock, renderHeader, renderFooter, renderDocument, renderSermon, renderEvent, newBlock, newSection, mobileOrder, upcoming, latestSermons, fmtDate, fmtWhen, audioUrl, videoEmbed, icon };
});
