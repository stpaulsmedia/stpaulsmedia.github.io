/* Local editor server. Runs only on this Mac (127.0.0.1).
   - http://localhost:4173/_editor/   the editor
   - http://localhost:4173/           live preview of the site from content/
   Start with:  node editor/server.js  (or the Website Editor app). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../lib/store');
const R = require('../src/render.js');
const { build, context } = require('../build.js');

/* The Dock app starts this with a bare PATH, so add the places git and gh are installed. */
process.env.PATH = [path.join(require('os').homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');

const PORT = +process.env.PORT || 4173;
const ROOT = store.ROOT;
const MEDIA = path.join(store.CONTENT, 'media');
const AUDIO = path.join(ROOT, 'audio');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.xml': 'application/xml', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((ok, bad) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', bad); });
const safeName = name => { const ext = path.extname(name).toLowerCase(); return (path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file') + ext; };
function uniquePath(dir, name) { let n = name, i = 2; while (fs.existsSync(path.join(dir, n))) n = name.replace(/(\.[^.]+)?$/, `-${i++}$1`); return n; }

function sendFile(req, res, file, baseDir) {
  const full = path.resolve(file);
  if (!full.startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found', 'text/plain');
  const size = fs.statSync(full).size, type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}

/* ---------- git / publishing ---------- */
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args) => { try { return git(...args); } catch (e) { return null; } };
function status() {
  const remote = tryGit('remote', 'get-url', 'origin');
  const changed = (tryGit('status', '--porcelain', '--', 'content', 'src') || '').split('\n').filter(Boolean).length;
  const ahead = remote ? +(tryGit('rev-list', '--count', 'origin/main..HEAD') || 0) : 0;
  return { remote: remote || '', changed, ahead, lastPublish: tryGit('log', '-1', '--format=%cI', 'origin/main') || '' };
}
/* Sermon recordings are too big for the website itself, so they live in a GitHub "release" named audio. */
function syncAudio() {
  if (!fs.existsSync(AUDIO)) return '';
  const gh = (...args) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { gh('--version'); } catch (e) { return ' New sermon recordings were not uploaded because the GitHub tool (gh) is not installed on this Mac.'; }
  let have = [];
  try { have = JSON.parse(gh('release', 'view', 'audio', '--json', 'assets')).assets.map(a => a.name); }
  catch (e) { gh('release', 'create', 'audio', '--title', 'Sermon audio', '--notes', 'Audio files for the sermon podcast.'); }
  const todo = fs.readdirSync(AUDIO).filter(f => f.endsWith('.mp3') && !have.includes(f));
  for (const f of todo) gh('release', 'upload', 'audio', path.join(AUDIO, f));
  return '';
}
function publish(message) {
  build();   // fail early if anything is broken
  if (!tryGit('rev-parse', '--git-dir')) git('init', '-b', 'main');
  git('add', '-A');
  if (tryGit('status', '--porcelain')) git('-c', 'user.name=Website Editor', '-c', 'user.email=editor@localhost', 'commit', '-m', message || 'Update website');
  if (!tryGit('remote', 'get-url', 'origin')) return { ok: false, saved: true, error: 'Your changes are saved in the site history, but this Mac is not connected to GitHub yet, so nothing went live.' };
  let warn = '';
  try { warn = syncAudio(); git('push', 'origin', 'HEAD:main'); } catch (e) { return { ok: false, saved: true, error: 'Could not reach GitHub: ' + String(e.stderr || e.message).split('\n').slice(-3).join(' ') }; }
  return warn ? { ok: false, saved: true, error: 'The site was published.' + warn } : { ok: true };
}
function history() {
  const out = tryGit('log', '-40', '--format=%H|%cI|%s') || '';
  return out.split('\n').filter(Boolean).map(l => { const [hash, date, ...msg] = l.split('|'); return { hash, date, message: msg.join('|') }; });
}
function restore(hash) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error('Bad version id');
  git('restore', '--source=' + hash, '--staged', '--worktree', '--', 'content');   // also removes pages added since that version
  return publish('Restore site to version from ' + (tryGit('log', '-1', '--format=%cd', '--date=format:%b %e, %Y %l:%M %p', hash) || hash.slice(0, 7)));
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname.replace('/_api/', ''), q = url.searchParams, m = req.method;
  const summary = kind => store.list(kind).map(d => ({ slug: d.slug, title: d.title, date: d.date || d.start || '', hidden: !!d.hidden }));
  if (p === 'state' && m === 'GET') return send(res, 200, { site: store.site(), pages: summary('pages'), sermons: summary('sermons'), events: summary('events'), all: { sermons: store.list('sermons'), events: store.list('events') } });
  if (p === 'fonts') return sendFile(req, res, path.join(ROOT, 'editor', 'fonts.json'), ROOT);
  if (p === 'site' && m === 'PUT') { store.saveSite(JSON.parse(await readBody(req))); return send(res, 200, { ok: true }); }
  if (p === 'doc') {
    const kind = q.get('kind'), slug = q.get('slug');
    if (!store.KINDS.includes(kind)) return send(res, 400, { error: 'Unknown type' });
    if (m === 'GET') return store.exists(kind, slug) ? send(res, 200, store.get(kind, slug)) : send(res, 404, { error: 'Not found' });
    if (m === 'PUT') { const doc = store.save(kind, slug, JSON.parse(await readBody(req)), q.get('old') || ''); return send(res, 200, doc); }
    if (m === 'DELETE') { store.remove(kind, slug); return send(res, 200, { ok: true }); }
  }
  if (p === 'media' && m === 'GET') {
    const files = fs.existsSync(MEDIA) ? fs.readdirSync(MEDIA).filter(f => /\.(png|jpe?g|gif|webp|svg)$/i.test(f)).map(f => ({ url: '/media/' + f, time: fs.statSync(path.join(MEDIA, f)).mtimeMs })) : [];
    return send(res, 200, files.sort((a, b) => b.time - a.time));
  }
  if (p === 'upload' && m === 'POST') {
    const kind = q.get('kind') || 'image', dir = kind === 'audio' ? AUDIO : kind === 'file' ? path.join(MEDIA, 'files') : MEDIA;
    fs.mkdirSync(dir, { recursive: true });
    const name = uniquePath(dir, safeName(q.get('name') || 'upload')), data = await readBody(req);
    fs.writeFileSync(path.join(dir, name), data);
    return send(res, 200, { url: kind === 'audio' ? name : (kind === 'file' ? '/media/files/' : '/media/') + name, bytes: data.length });
  }
  if (p === 'status') return send(res, 200, status());
  if (p === 'history') return send(res, 200, history());
  if (p === 'publish' && m === 'POST') return send(res, 200, publish((JSON.parse((await readBody(req)).toString() || '{}')).message));
  if (p === 'restore' && m === 'POST') return send(res, 200, restore(JSON.parse(await readBody(req)).hash));
  send(res, 404, { error: 'Unknown request' });
}

/* ---------- live preview of the site ---------- */
function preview(res, pathname) {
  const ctx = context({ audioBase: '/audio/' });
  const rel = decodeURIComponent(pathname).replace(/^\/|\/$/g, '');
  let kind = 'pages', slug = rel || 'home';
  if (rel.startsWith('podcast/') && store.exists('sermons', rel.slice(8))) { kind = 'sermons'; slug = rel.slice(8); }
  else if (rel.startsWith('upcoming/') && store.exists('events', rel.slice(9))) { kind = 'events'; slug = rel.slice(9); }
  if (store.exists(kind, slug)) return send(res, 200, R.renderDocument(kind, store.get(kind, slug), ctx), TYPES['.html']);
  const to = (ctx.site.redirects || {})['/' + rel];
  if (to) { res.writeHead(302, { Location: to }); return res.end(); }
  send(res, 404, '<h1>Page not found</h1><p><a href="/">Home</a></p>', TYPES['.html']);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/_api/')) return await api(req, res, url);
    if (p === '/_editor' || p === '/_editor/') return sendFile(req, res, path.join(ROOT, 'editor', 'index.html'), ROOT);
    if (p.startsWith('/_editor/')) return sendFile(req, res, path.join(ROOT, 'editor', decodeURIComponent(p.slice(9))), path.join(ROOT, 'editor'));
    if (p.startsWith('/assets/') || p.startsWith('/_src/')) return sendFile(req, res, path.join(ROOT, 'src', decodeURIComponent(p.replace(/^\/(assets|_src)\//, ''))), path.join(ROOT, 'src'));
    if (p.startsWith('/media/')) return sendFile(req, res, path.join(MEDIA, decodeURIComponent(p.slice(7))), MEDIA);
    if (p.startsWith('/audio/')) return sendFile(req, res, path.join(AUDIO, decodeURIComponent(p.slice(7))), AUDIO);
    if (p === '/podcast/feed.xml') return send(res, 200, require('../build.js').feed(context({ audioBase: '/audio/' })), TYPES['.xml']);
    preview(res, p);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || String(e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Website editor running at http://localhost:${PORT}/_editor/`));
