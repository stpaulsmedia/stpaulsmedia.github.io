/* Builds the finished static website into dist/ from the files in content/. */
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const R = require('./src/render.js');

const xml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function copyDir(from, to) { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); }
function hms(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); }

function context(opts) {
  const site = store.site();
  if (opts && opts.audioBase) site.podcast.audioBase = opts.audioBase;
  const pages = store.list('pages'), sermons = store.list('sermons'), events = store.list('events');
  let catalog = []; try { catalog = store.readJson(path.join(store.ROOT, 'editor', 'fonts.json')); } catch (e) {}
  const ctx = { site, pages, sermons, events, version: Date.now().toString(36) };
  ctx.fontsHref = R.fontsHref(R.fontsUsed(site, pages), catalog);
  return ctx;
}

function feed(ctx) {
  const { site } = ctx, p = site.podcast, abs = u => /^https?:/.test(u) ? u : site.url + u;
  const items = R.latestSermons(ctx.sermons).filter(s => s.audio).map(s => `<item><title>${xml(s.title)}</title><link>${xml(site.url)}/podcast/${xml(s.slug)}/</link><guid isPermaLink="false">${xml(s.guid || site.url + '/podcast/' + s.slug)}</guid><pubDate>${new Date(s.published || s.date + 'T17:00:00Z').toUTCString()}</pubDate><description>${xml(s.description)}</description><itunes:summary>${xml(s.description)}</itunes:summary><itunes:author>${xml(s.speaker || p.author)}</itunes:author><itunes:explicit>false</itunes:explicit>${s.duration ? `<itunes:duration>${hms(s.duration)}</itunes:duration>` : ''}<enclosure url="${xml(abs(R.audioUrl(site, s.audio)))}" length="${s.audioBytes || 0}" type="audio/mpeg"/></item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${xml(p.title)}</title><link>${xml(site.url)}/podcast/</link><atom:link href="${xml(site.url)}/podcast/feed.xml" rel="self" type="application/rss+xml"/><language>en</language><description>${xml(p.description)}</description><itunes:author>${xml(p.author)}</itunes:author><itunes:owner><itunes:name>${xml(p.ownerName)}</itunes:name><itunes:email>${xml(p.ownerEmail)}</itunes:email></itunes:owner><itunes:explicit>false</itunes:explicit><itunes:type>episodic</itunes:type>${p.image ? `<itunes:image href="${xml(abs(p.image))}"/>` : ''}<itunes:category text="Religion &amp; Spirituality"><itunes:category text="Christianity"/></itunes:category>\n${items}\n</channel></rss>\n`;
}

function build(opts) {
  opts = opts || {};
  const out = opts.out || path.join(store.ROOT, 'dist');
  const ctx = context(opts), { site } = ctx;
  const base = (opts.basePath || '').replace(/\/$/, '');
  const fix = html => base ? html.replace(/(href|src|action)="\/(?!\/)/g, `$1="${base}/`).replace(/url\('\/(?!\/)/g, `url('${base}/`) : html;
  fs.rmSync(out, { recursive: true, force: true });
  const urls = [];
  const emit = (rel, kind, doc) => { write(path.join(out, rel, 'index.html'), fix(R.renderDocument(kind, doc, ctx))); if (!doc.hidden) urls.push('/' + (rel ? rel + '/' : '')); };
  ctx.pages.forEach(p => emit(p.slug === 'home' ? '' : p.slug, 'pages', p));
  ctx.sermons.forEach(s => emit('podcast/' + s.slug, 'sermons', s));
  ctx.events.forEach(e => emit('upcoming/' + e.slug, 'events', e));

  for (const from in (site.redirects || {})) {
    const to = site.redirects[from], rel = from.replace(/^\/|\/$/g, '');
    if (fs.existsSync(path.join(out, rel, 'index.html'))) continue;
    write(path.join(out, rel, 'index.html'), fix(`<!doctype html><meta charset="utf-8"><title>Redirecting…</title><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><meta name="robots" content="noindex"><a href="${to}">Continue</a>`));
  }
  const notFound = { title: 'Page not found', slug: '404', hidden: true, sections: [{ id: 'nf', theme: 'white', blocks: [{ id: 'nf1', type: 'text', d: { x: 4, y: 2, w: 16, h: 6 }, props: { html: '<h1>We couldn’t find that page</h1><p>It may have moved. Try the menu above, or <a href="/">head back home</a>.</p>' }, style: { align: 'center' } }] }] };
  write(path.join(out, '404.html'), fix(R.renderDocument('pages', notFound, ctx)));

  copyDir(path.join(store.ROOT, 'src', 'site.css'), path.join(out, 'assets', 'site.css'));
  copyDir(path.join(store.ROOT, 'src', 'site.js'), path.join(out, 'assets', 'site.js'));
  copyDir(path.join(store.CONTENT, 'media'), path.join(out, 'media'));
  write(path.join(out, 'podcast', 'feed.xml'), feed(ctx));
  write(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${xml(site.url + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  write(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
  write(path.join(out, '.nojekyll'), '');
  if (site.cname && !base) write(path.join(out, 'CNAME'), site.cname + '\n');
  return { pages: ctx.pages.length, sermons: ctx.sermons.length, events: ctx.events.length, out };
}

module.exports = { build, context, feed };
if (require.main === module) {
  const arg = n => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : ''; };
  const r = build({ basePath: arg('base'), audioBase: arg('audio') });
  console.log(`Built ${r.pages} pages, ${r.sermons} sermons, ${r.events} events → ${r.out}`);
}
