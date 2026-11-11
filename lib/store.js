/* Reads and writes the content files. Shared by the build and the editor. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const KINDS = ['pages', 'sermons', 'events'];
const fileFor = (kind, slug) => path.join(CONTENT, kind, slug.replace(/\//g, '__') + '.json');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 1) + '\n'); };
const cleanSlug = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9/]+/g, '-').replace(/^[-/]+|[-/]+$/g, '').replace(/\/+/g, '/');

module.exports = {
  ROOT, CONTENT, KINDS, cleanSlug, readJson, writeJson,
  site: () => readJson(path.join(CONTENT, 'site.json')),
  saveSite: data => writeJson(path.join(CONTENT, 'site.json'), data),
  list(kind) {
    const dir = path.join(CONTENT, kind);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f)));
  },
  get: (kind, slug) => readJson(fileFor(kind, slug)),
  exists: (kind, slug) => fs.existsSync(fileFor(kind, slug)),
  save(kind, slug, doc, oldSlug) {
    if (!KINDS.includes(kind)) throw new Error('Unknown kind');
    doc.slug = cleanSlug(slug); if (!doc.slug) throw new Error('A web address is required');
    if (oldSlug && oldSlug !== doc.slug) {
      if (fs.existsSync(fileFor(kind, doc.slug))) throw new Error('Another item already uses that web address');
      if (fs.existsSync(fileFor(kind, oldSlug))) fs.unlinkSync(fileFor(kind, oldSlug));
    }
    writeJson(fileFor(kind, doc.slug), doc); return doc;
  },
  remove(kind, slug) { const f = fileFor(kind, slug); if (fs.existsSync(f)) fs.unlinkSync(f); }
};
