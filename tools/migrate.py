"""One-off migration: converts the captured Squarespace site (_capture/) into
content/ JSON for the new site, downloading images and files as it goes.
Run:  python3 -I tools/migrate.py
"""
import hashlib, json, os, re, subprocess, sys, urllib.parse, datetime, shutil
from html.parser import HTMLParser
from zoneinfo import ZoneInfo
from html import unescape

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CAP = os.path.join(ROOT, "_capture")
CONTENT = os.path.join(ROOT, "content")
MEDIA = os.path.join(CONTENT, "media")
TZ = ZoneInfo("America/Chicago")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
notes = []

# ---------------------------------------------------------------- mini DOM
class Node:
    def __init__(self, tag=None, attrs=None, parent=None, text=""):
        self.tag, self.attrs, self.parent, self.text, self.children = tag, dict(attrs or {}), parent, text, []
    def cls(self): return set((self.attrs.get("class") or "").split())
    def has(self, c): return c in self.cls()
    def walk(self):
        for c in self.children:
            yield c
            if c.tag: yield from c.walk()
    def find_all(self, pred): return [n for n in self.walk() if n.tag and pred(n)]
    def find(self, pred):
        for n in self.walk():
            if n.tag and pred(n): return n
        return None
    def by_class(self, c): return self.find_all(lambda n: n.has(c))
    def first_class(self, c): return self.find(lambda n: n.has(c))
    def text_content(self):
        if self.tag is None: return self.text
        if self.tag in ("script", "style"): return ""
        return "".join(c.text_content() for c in self.children)

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.root = Node("root"); self.cur = self.root
    def handle_starttag(self, tag, attrs):
        n = Node(tag, [(k, v if v is not None else "") for k, v in attrs], self.cur); self.cur.children.append(n)
        if tag not in VOID: self.cur = n
    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, [(k, v or "") for k, v in attrs], self.cur))
    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag: n = n.parent
        if n is not self.root: self.cur = n.parent
    def handle_data(self, data): self.cur.children.append(Node(None, None, self.cur, data))

def parse(html):
    p = Parser(); p.feed(html); return p.root

# ---------------------------------------------------------------- media
_media = {}
def safe_name(name):
    name = urllib.parse.unquote(name).replace("+", "-")
    base, ext = os.path.splitext(name)
    base = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower()[:60] or "file"
    return base + ext.lower()

def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0: return True
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    r = subprocess.run(["curl", "-sL", "--fail", "-A", "Mozilla/5.0", "-o", dest, url])
    if r.returncode != 0:
        notes.append(f"DOWNLOAD FAILED: {url}")
        if os.path.exists(dest): os.remove(dest)
        return False
    return True

def image(url, width=1500):
    if not url: return ""
    if url.startswith("//"): url = "https:" + url
    url = url.split("?")[0]
    if url in _media: return _media[url]
    name = safe_name(url.rsplit("/", 1)[-1])
    if not os.path.splitext(name)[1]: name += ".jpg"
    taken = set(_media.values())
    if "/media/" + name in taken: name = hashlib.md5(url.encode()).hexdigest()[:6] + "-" + name
    ok = fetch(url + f"?format={width}w", os.path.join(MEDIA, name))
    _media[url] = "/media/" + name if ok else ""
    return _media[url]

def link(href):
    if not href: return ""
    href = href.strip()
    href = re.sub(r"^https?://(www\.)?sp4u\.org", "", href) or "/"
    if href.startswith("/s/"):
        name = safe_name(href.rsplit("/", 1)[-1].split("?")[0])
        if fetch("https://www.sp4u.org" + href, os.path.join(MEDIA, "files", name)): return "/media/files/" + name
        return href
    if href in ("/home", "/home/"): return "/"
    if href == "/volunteer": return "/volunteer-at-stpauls"
    return href

# ---------------------------------------------------------------- text cleaning
KEEP = {"h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "a", "strong", "em", "b", "i", "u", "br", "blockquote", "span", "sup", "sub"}
def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
def clean(node):
    out = []
    for c in node.children:
        if c.tag is None: out.append(esc(c.text)); continue
        if c.tag in ("script", "style"): continue
        inner = clean(c)
        if c.tag not in KEEP or c.tag == "span": out.append(inner); continue
        if c.tag == "br": out.append("<br>"); continue
        if c.tag == "a":
            h = link(c.attrs.get("href", ""))
            out.append(f'<a href="{esc(h)}">{inner}</a>' if h else inner); continue
        tag = {"b": "strong", "i": "em"}.get(c.tag, c.tag)
        if tag in ("p", "h1", "h2", "h3", "h4") and not re.sub(r"<br>|\s|&nbsp;| ", "", inner): continue
        out.append(f"<{tag}>{inner}</{tag}>")
    return re.sub(r"[ \t\r\n]+", " ", "".join(out)).strip()

def alignment(node):
    styles = [c.attrs.get("style", "") for c in node.children if c.tag]
    cen = sum("text-align:center" in s.replace(" ", "") for s in styles)
    return "center" if styles and cen >= len(styles) / 2 and cen else ""

def text_rows(html, w):
    px = 0
    for tag, body in re.findall(r"<(h1|h2|h3|h4|p|li)>(.*?)</\1>", html, flags=re.S):
        n = len(re.sub(r"<[^>]+>", "", body)); size = {"h1": 56, "h2": 42, "h3": 30, "h4": 22}.get(tag, 17)
        per_line = max(8, int(w * 50 / (size * 0.5)))
        px += (n // per_line + 1) * size * (1.2 if tag[0] == "h" else 1.55) + (size * 0.5 if tag[0] == "h" else 16)
    return max(1, int(px * 0.85 / 24))

# ---------------------------------------------------------------- blocks
_id = [0]
def nid(p="m"):
    _id[0] += 1; return f"{p}{_id[0]:04d}"
def blk(type_, props, w=None, h=None, style=None):
    return {"id": nid(), "type": type_, "props": props, "style": style or {}, "_w": w, "_h": h}

def convert(b, w):
    """Squarespace block node -> list of new blocks (not yet positioned)."""
    kind = (b.attrs.get("data-definition-name") or "").replace("website.components.", "")
    if not kind:
        if b.has("sqs-block-instagram") or b.has("instagram-block"): return []
        return []
    if kind == "html":
        c = b.first_class("sqs-html-content") or b
        html = clean(c)
        if not html: return []
        st = {"align": alignment(c)} if alignment(c) else {}
        return [blk("text", {"html": html}, h=text_rows(html, w), style=st)]
    if kind == "button":
        a = b.find(lambda n: n.tag == "a")
        if not a: return []
        cont = b.first_class("sqs-block-button-container")
        cl = " ".join(cont.cls()) if cont else ""
        align = "center" if "--center" in cl else "right" if "--right" in cl else "left"
        variant = "outline" if (cont and cont.attrs.get("data-button-type") in ("secondary", "tertiary")) else "primary"
        label = re.sub(r"\s+", " ", a.text_content()).strip()
        return [blk("button", {"label": label, "href": link(a.attrs.get("href", "")), "variant": variant, "size": "", "align": align}, h=2)]
    if kind in ("imageLayout", "imageFluid"):
        im = b.find(lambda n: n.tag == "img" and (n.attrs.get("data-src") or n.attrs.get("src")))
        if not im: return []
        src = image(im.attrs.get("data-src") or im.attrs.get("src"))
        dims = (im.attrs.get("data-image-dimensions") or "4x3").split("x")
        try: ratio = float(dims[0]) / float(dims[1])
        except Exception: ratio = 1.33
        a = b.find(lambda n: n.tag == "a" and n.attrs.get("href") and n.find(lambda m: m.tag == "img"))
        fig = b.first_class("sqs-block-image-figure"); fcl = " ".join(fig.cls()) if fig else ""
        pair = ("design-layout-collage" in fcl or "design-layout-card" in fcl or "design-layout-overlap" in fcl) and w >= 12
        iw = w // 2 - 1 if pair else w
        out = [blk("image", {"src": src, "alt": im.attrs.get("alt", ""), "fit": "cover", "href": link(a.attrs["href"]) if a else "", "caption": "", "focus": "50% 50%"}, h=max(4, min(20, round(iw * 50 / ratio / 24))))]
        if pair: out[0]["_side"] = "r" if "image-position-right" in fcl else "l"
        extra = ""
        t = b.first_class("image-title"); s = b.first_class("image-subtitle")
        if t and clean(t): extra += "<h3>" + re.sub(r"</?(p|h\d)>", "", clean(t)) + "</h3>"
        if s and clean(s): extra += clean(s)
        btn = b.first_class("image-button")
        if extra: out.append(blk("text", {"html": extra}, h=text_rows(extra, w)))
        if btn:
            ba = btn.find(lambda n: n.tag == "a")
            if ba: out.append(blk("button", {"label": ba.text_content().strip(), "href": link(ba.attrs.get("href", "")), "variant": "primary", "size": "", "align": "left"}, h=2))
        return out
    if kind == "horizontalrule": return [blk("divider", {"width": 100, "thickness": 1}, h=1)]
    if kind == "spacer": return [{"_spacer": 1}]
    if kind == "form":
        notes.append("FORM placeholder (needs a Google Form link)")
        return [blk("gform", {"url": "", "label": "Open the form"}, h=6)]
    if kind == "map": return [blk("map", {"query": "5508 Telegraph Road, St. Louis, MO 63129", "zoom": 14}, h=12)]
    if kind == "accordion":
        items = []
        for it in b.by_class("accordion-item"):
            t = it.first_class("accordion-item__title"); d = it.first_class("accordion-item__description")
            items.append({"title": re.sub(r"\s+", " ", t.text_content()).strip() if t else "", "html": clean(d) if d else ""})
        return [blk("accordion", {"items": items}, h=max(3, len(items) * 3))]
    if kind == "summary":
        hrefs = " ".join(a.attrs.get("href", "") for a in b.find_all(lambda n: n.tag == "a"))
        if "/podcast/" in hrefs: return [blk("sermons", {"count": 5, "layout": "cards"}, h=10)]
        return [blk("events", {"count": 3, "layout": "cards", "empty": "No upcoming events right now. Check back soon!"}, h=12)]
    if kind == "blogList": return [blk("sermons", {"count": 200, "layout": "list"}, h=40)]
    if kind == "video":
        notes.append("VIDEO placeholder (needs a YouTube link)")
        return [blk("video", {"url": "", "title": ""}, h=max(6, round(w * 50 * 9 / 16 / 24)))]
    if kind == "socialLinks": return [blk("social", {"align": "center", "labels": False}, h=2)]
    if kind in ("code", "embed"):
        c = b.first_class("sqs-code-container") or b.first_class("sqs-embed-container") or b
        if c.find(lambda n: n.attrs.get("id") == "sermon-description"): return [blk("sermons", {"count": 1, "layout": "featured"}, h=8)]
        fr = c.find(lambda n: n.tag == "iframe")
        if fr:
            src = fr.attrs.get("src") or fr.attrs.get("data-src") or ""
            if src.startswith("//"): src = "https:" + src
            if "youtu" in src: return [blk("video", {"url": src, "title": fr.attrs.get("title", "")}, h=max(6, round(w * 50 * 9 / 16 / 24)))]
            return [blk("embed", {"html": f'<iframe src="{esc(src)}" style="width:100%;min-height:420px;border:0" loading="lazy"></iframe>'}, h=18)]
        txt = re.sub(r"\s+", " ", c.text_content()).strip()
        notes.append(f"CODE block skipped: {txt[:90]!r}")
        return []
    if kind == "shape": return []
    notes.append(f"UNHANDLED block type: {kind}")
    return []

def place(b, x, y, w):
    h = b.pop("_h") or 3; b.pop("_w", None)
    b["d"] = {"x": int(x), "y": int(y), "w": int(max(2, w)), "h": int(h)}; b["m"] = None
    return b

THEMES = {"white": "white", "white-bold": "white", "light": "light", "light-bold": "light", "bright": "accent", "bright-bold": "accent", "dark": "dark", "dark-bold": "dark", "black": "dark", "black-bold": "dark", "": "white"}

def classic(sec, out):
    """Classic row/column sections: map 12-col spans to the 24-col grid."""
    cl = sec.cls()
    x0, wt = (6, 12) if "content-width--narrow" in cl else (3, 18) if "content-width--medium" in cl else (1, 22)
    def col_walk(col, x, w, y):
        for ch in col.children:
            if not ch.tag: continue
            if ch.has("row"): y = row_walk(ch, x, w, y)
            elif ch.has("sqs-block"):
                made = convert(ch, w)
                if made and made[0].get("_side"):
                    side = made[0].pop("_side"); half = w // 2
                    ix, tx = (x + half + 1, x) if side == "r" else (x, x + half + 1)
                    place(made[0], ix, y, half - 1); out.append(made[0]); ty = y + 1
                    for nb in made[1:]:
                        if nb["type"] == "text": nb["_h"] = text_rows(nb["props"]["html"], half - 1)
                        place(nb, tx, ty, half - 1); out.append(nb); ty += nb["d"]["h"] + 1
                    y = max(y + made[0]["d"]["h"], ty) + 1; continue
                for nb in made:
                    if "_spacer" in nb: y += 2; continue
                    nb.pop("_side", None)
                    place(nb, x, y, w); out.append(nb); y += nb["d"]["h"] + 1
            else: y = col_walk(ch, x, w, y)
        return y
    def row_walk(row, x, w, y):
        cols = [c for c in row.children if c.tag and c.has("col")]
        if not cols: return col_walk(row, x, w, y)
        cx, maxy = x, y
        for c in cols:
            span = next((int(k[5:]) for k in c.cls() if k.startswith("span-") and k[5:].isdigit()), 12)
            cw = max(2, round(span * wt / 12))
            inner_w = cw - 1 if len(cols) > 1 else cw
            maxy = max(maxy, col_walk(c, cx, min(inner_w, x0 + wt - cx), y)); cx += cw
        return maxy
    layout = sec.first_class("sqs-layout")
    if layout: col_walk(layout, x0, wt, 0)

def fluid(sec, out):
    css = " ".join(s.text_content() if False else "".join(c.text for c in s.children if c.tag is None) for s in sec.find_all(lambda n: n.tag == "style"))
    for fb in sec.by_class("fe-block"):
        fid = next((k for k in fb.cls() if k.startswith("fe-block-")), "")
        areas = re.findall(re.escape("." + fid) + r"\s*\{[^}]*?grid-area:\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)", css)
        areas += re.findall(r"@media[^{]*min-width[^{]*\{\s*" + re.escape("." + fid) + r"\s*\{[^}]*?grid-area:\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*/\s*(\d+)", css)
        area = max(([int(v) for v in a] for a in areas), key=lambda a: a[3], default=None)
        b = fb.first_class("sqs-block")
        if not b: continue
        if area:
            r1, c1, r2, c2 = area
            x = max(0, min(22, c1 - 2)); w = max(2, min(24 - x, c2 - c1))
            y = round((r1 - 1) * 1.45); h = max(1, round((r2 - r1) * 1.45))
        else: x, w, y, h = 2, 20, 0, 4
        yy = y
        for nb in convert(b, w):
            if "_spacer" in nb: continue
            nb.pop("_side", None)
            est = nb["_h"]
            if nb["type"] in ("image", "video", "map"): nb["_h"] = h
            elif nb["type"] in ("button", "divider", "social"): nb["_h"] = min(h, 3)
            else: nb["_h"] = max(1, min(h, est + 1)) if nb["type"] == "text" else h
            place(nb, x, yy, w); out.append(nb); yy += nb["d"]["h"] + 1

def list_section(sec, out, as_staff):
    ctxn = None; data = {}
    for n in sec.find_all(lambda n: "data-current-context" in n.attrs):
        try: dd = json.loads(n.attrs["data-current-context"])
        except Exception: continue
        if dd.get("userItems"): ctxn, data = n, dd; break
    JUNK = ("New List Item", "Maybe you want to turn", "Maybe you have a creative", "Make it stand out", "Item 1", "Item 2")
    items = [i for i in (data.get("userItems") or []) if not any((i.get("title") or "").startswith(j) for j in JUNK) and "It all begins with an idea" not in (i.get("description") or "")]
    if not items: return
    y = 0
    title = sec.first_class("list-section-title")
    if title and clean(title):
        t = clean(title); t = t if t.startswith("<h") else "<h2>" + re.sub(r"</?p>", "", t) + "</h2>"
        out.append(place(blk("text", {"html": t}, h=3, style={"align": "center"}), 2, 0, 20)); y = 4
    cols = min(4, max(1, len(items))) if len(items) != 2 else 2
    if as_staff:
        its = [{"image": image((i.get("image") or {}).get("assetUrl", ""), 750), "name": i.get("title", ""), "role": "", "html": tidy(i.get("description", "")), "email": mail(i)} for i in items]
        for it in its:  # first short paragraph is usually the job title
            m = re.match(r"<p>([^<]{2,70})</p>(.*)", it["html"], flags=re.S)
            if m: it["role"], it["html"] = unescape(m.group(1)), m.group(2)
        out.append(place(blk("staff", {"cols": cols, "shape": "round", "items": its}, h=(len(its) + cols - 1) // cols * 14), 1, y, 22))
    else:
        its = [{"image": image((i.get("image") or {}).get("assetUrl", ""), 1000), "title": i.get("title", ""), "html": tidy(i.get("description", "")), "label": (i.get("button") or {}).get("buttonText", "") if (i.get("button") or {}).get("buttonLink") else "", "href": link((i.get("button") or {}).get("buttonLink", ""))} for i in items]
        out.append(place(blk("cards", {"cols": min(cols, 3) if len(its) % 3 == 0 else cols, "style": "card", "ratio": "4/3", "items": its}, h=(len(its) + cols - 1) // cols * 16), 1, y, 22))

def mail(i):
    href = (i.get("button") or {}).get("buttonLink", "") or ""
    return href[7:].split("?")[0] if href.startswith("mailto:") else ""
def tidy(html):
    return clean(parse(html or "")) if html else ""

def gallery_section(sec, out):
    ims = []
    for im in sec.find_all(lambda n: n.tag == "img" and (n.attrs.get("data-src") or n.attrs.get("src"))):
        src = image(im.attrs.get("data-src") or im.attrs.get("src"), 1000)
        if src and src not in [i["src"] for i in ims]: ims.append({"src": src, "alt": im.attrs.get("alt", "")})
    if ims: out.append(place(blk("gallery", {"mode": "grid", "cols": min(4, len(ims)), "ratio": "1/1", "images": ims}, h=10), 1, 0, 22))

def tidy_section(blocks):
    """Free-form sections: close empty space at the top and stop images sliding under text."""
    if not blocks: return
    top = min(b["d"]["y"] for b in blocks)
    for b in blocks: b["d"]["y"] -= top
    for im in [b for b in blocks if b["type"] in ("image", "video")]:
        for t in [b for b in blocks if b["type"] not in ("image", "video", "shape")]:
            a, c = im["d"], t["d"]
            if a["x"] < c["x"] + c["w"] and c["x"] < a["x"] + a["w"] and a["y"] < c["y"] + c["h"] and c["y"] < a["y"] + a["h"]:
                if c["x"] > a["x"]: a["w"] = max(3, c["x"] - a["x"] - 1)
                else:
                    nx = c["x"] + c["w"] + 1; a["w"] = max(3, a["w"] - (nx - a["x"])); a["x"] = min(nx, 24 - a["w"])

def T(html, x, y, w, h, **style): return {"id": nid(), "type": "text", "d": {"x": x, "y": y, "w": w, "h": h}, "m": None, "props": {"html": html}, "style": style}
def B(label, href, x, y, w, variant="primary", align="left", **style): return {"id": nid(), "type": "button", "d": {"x": x, "y": y, "w": w, "h": 2}, "m": None, "props": {"label": label, "href": href, "variant": variant, "size": "", "align": align}, "style": style}
def X(type_, props, x, y, w, h, **style): return {"id": nid(), "type": type_, "d": {"x": x, "y": y, "w": w, "h": h}, "m": None, "props": props, "style": style}
def SEC(theme, blocks, **kw): return dict({"id": nid("s"), "theme": theme, "blocks": blocks}, **kw)
YT = "https://www.youtube.com/channel/UCrbUrKU7f3Lqznyqia2IBeQ"
SPOTIFY = "https://open.spotify.com/show/5QKY2vEayubUT6AP5EKXwL"

def polish():
    """Hand-finished layouts for the pages that need more than an automatic conversion."""
    load = lambda n: json.load(open(os.path.join(CONTENT, "pages", n + ".json")))
    # ---- Home
    old = load("home"); texts = [b["props"]["html"] for s in old["sections"] for b in s["blocks"] if b["type"] == "text"]
    find = lambda key: next((t for t in texts if key in t), "")
    about = find("what we’re about"); ucc = find("About The UCC")
    mins = [t for t in texts if t.startswith("<h3>") and "Ministry" in t[:40]]
    imgs = ["/media/untitled-design-5.jpg", "/media/img-7411-2.jpg", "/media/img-7080.jpg"]; links = ["/childrens-ministry", "/youth-ministry", "/adult-ministry"]
    cards = []
    for t, im, href in zip(mins, imgs, links):
        m = re.match(r"<h3>(.*?)</h3>(.*)", t, flags=re.S)
        first = re.match(r"(<p>.*?</p>)", m.group(2), flags=re.S)
        cards.append({"image": im, "title": unescape(re.sub(r"<[^>]+>", "", m.group(1))), "html": first.group(1) if first else m.group(2), "label": "Learn More", "href": href})
    home = {"title": "Home", "slug": "home", "description": old.get("description", ""), "sections": [
        SEC("dark", [T('<p class="eyebrow">Join us this week</p><h1>A Place of Worship, Refuge, and Outreach</h1><p class="lead">Sundays at 9:00 am (Heritage) and 10:45 am (Connections)<br>5508 Telegraph Road, Oakville</p>', 1, 0, 14, 11),
                     B("Plan a Visit", "/new-guests", 1, 12, 5), B("Watch Online", YT + "/streams", 6, 12, 5, "outline")],
            bgImage="/media/church-exterior.png", bgFocus="50% 50%", overlay="#000000", overlayOpacity=50, minHeight=78),
        SEC("light", [X("image", {"src": "/media/sock-hop-19.jpg", "alt": "Members of St. Paul's laughing together", "fit": "cover", "href": "", "caption": "", "focus": "50% 50%"}, 1, 0, 10, 17),
                      T(about, 13, 1, 10, 13), B("Learn More", "/about", 13, 15, 5)]),
        SEC("accent", [T('<p class="eyebrow">This week</p><h2>Watch the Latest Sermon</h2>', 1, 0, 9, 4),
                       X("sermons", {"count": 1, "layout": "featured"}, 1, 5, 9, 9, bg="white", color="dark", pad=28, radius=12),
                       B("All Sermons", "/podcast", 1, 15, 4), B("Listen on Spotify", SPOTIFY, 5, 15, 5, "outline"),
                       X("video", {"url": "https://www.youtube.com/embed?list=PL8XgctzrzfqXOeh1NF9EBFxxGHTuHd2ul", "title": "Latest worship service"}, 11, 0, 12, 14)]),
        SEC("white", [T("<h2>Featured Events</h2>", 3, 0, 18, 3, align="center"), X("events", {"count": 3, "layout": "cards", "empty": "No upcoming events right now. Check back soon!"}, 5, 3, 14, 12),
                      B("View All Events", "/events", 9, 16, 6, "outline", "center")]),
        SEC("light", [T("<h2>Our Ministries</h2>", 3, 0, 18, 3, align="center"), X("cards", {"cols": 3, "style": "card", "ratio": "4/3", "items": cards}, 1, 3, 22, 20)]),
        SEC("dark", [T(ucc, 1, 0, 13, 12), B("Learn More", "/about", 1, 13, 5),
                     X("image", {"src": "/media/ucc-jwfa-logo-white.png", "alt": "United Church of Christ", "fit": "contain", "href": "https://www.ucc.org", "caption": "", "focus": "50% 50%"}, 16, 2, 6, 9)]),
        SEC("white", [T("<h2>Sermon Podcast</h2><p>Missed a Sunday? Catch up on recent messages.</p>", 3, 0, 18, 5, align="center"), X("sermons", {"count": 3, "layout": "cards"}, 1, 5, 22, 8),
                      B("All Episodes", "/podcast", 9, 14, 6, "outline", "center")]),
        SEC("accent", [T("<h2>Thursday Thread</h2><p>Sign up for our weekly email newsletter and keep up with everything happening at St. Paul’s.</p>", 2, 0, 10, 7), B("Sign Up", "/contact-us", 2, 8, 5),
                       T("<h2>Follow Us</h2><p>See what’s happening this week.</p>", 14, 0, 9, 5), X("social", {"align": "left", "labels": True}, 14, 6, 9, 4)])]}
    save("pages", "home", home)
    # ---- Choir: videos now come from YouTube
    d = load("choir")
    d["sections"].append(SEC("white", [T("<h2>Christmas Cantatas</h2>", 1, 0, 22, 3),
        X("video", {"url": "https://www.youtube.com/watch?v=OSlB7B19kZ8", "title": "A Thrill of Hope - 2025 Christmas Cantata"}, 1, 3, 11, 13), T("<h4>A Thrill of Hope · Christmas Cantata 2025</h4>", 1, 17, 11, 2),
        X("video", {"url": "https://www.youtube.com/watch?v=tNDiRPhk4Zo", "title": "Christmas Presence - Cantata 2024"}, 12, 3, 11, 13), T("<h4>Christmas Presence · Christmas Cantata 2024</h4>", 12, 17, 11, 2)]))
    save("pages", "choir", d)
    # ---- Children's ministry: VBS video
    d = load("childrens-ministry")
    for s_ in d["sections"]:
        for b in s_["blocks"]:
            if b["type"] == "video" and not b["props"]["url"]: b["props"].update(url="https://www.youtube.com/watch?v=TXnZ1N1XPcc", title="VBS 2025 Road Trip")
    save("pages", "childrens-ministry", d)
    # ---- Podcast index
    save("pages", "podcast", {"title": "Sermon Podcast", "slug": "podcast", "description": "Weekly sermons from St. Paul's United Church of Christ in Oakville, MO.", "sections": [
        SEC("accent", [T('<h1>Sermon Podcast</h1><p class="lead">Weekly messages from St. Paul’s. Listen here, or subscribe wherever you get your podcasts.</p>', 2, 0, 14, 8), B("Listen on Spotify", SPOTIFY, 2, 9, 5), B("Watch on YouTube", YT, 7, 9, 5, "outline")]),
        SEC("white", [X("sermons", {"count": 200, "layout": "list"}, 3, 0, 18, 40)])]})

def migrate_page(slug, title, fname=None, description="", hidden=False):
    path = os.path.join(CAP, "html", (fname or slug.replace("/", "__")) + ".html")
    html = open(path).read()
    m = re.search(r'<meta name="description" content="([^"]*)"', html)
    description = description or (m.group(1) if m else "")
    main = parse(html[html.find("<main"):html.find("</main>") + 7])
    sections = []
    for sec in main.find_all(lambda n: n.tag == "section" and "data-section-id" in n.attrs):
        cl = sec.cls(); blocks = []
        try: st = json.loads(sec.attrs.get("data-current-styles") or "{}")
        except Exception: st = {}
        s = {"id": nid("s"), "theme": THEMES.get(sec.attrs.get("data-section-theme", ""), "white"), "blocks": blocks}
        bg = (st.get("backgroundImage") or {}).get("assetUrl")
        if bg and "has-background" in cl:
            s["bgImage"] = image(bg, 2500); s["bgFocus"] = "50% 50%"
            op = st.get("imageOverlayOpacity")
            s["overlay"] = "#000000"; s["overlayOpacity"] = int(round(float(op if op is not None else 0.3) * 100))
            if s["theme"] in ("white", "light"): s["theme"] = "dark"
        if "section-height--large" in cl: s["minHeight"] = 80
        elif "section-height--medium" in cl: s["minHeight"] = 55
        if "user-items-list-section" in cl or sec.first_class("user-items-list"): list_section(sec, blocks, slug in ("leadership", "teams"))
        elif "gallery-section" in cl or sec.first_class("gallery-section-wrapper") or sec.attrs.get("data-section-type") == "gallery": gallery_section(sec, blocks)
        elif sec.first_class("fluid-engine"): fluid(sec, blocks)
        else: classic(sec, blocks)
        tidy_section(blocks)
        only_home = len(blocks) == 1 and blocks[0]["type"] == "button" and blocks[0]["props"]["href"] == "/"
        if (blocks or s.get("bgImage")) and not only_home: sections.append(s)
    doc = {"title": title, "slug": slug, "description": description, "sections": sections}
    if hidden: doc["hidden"] = True
    save("pages", slug, doc)
    print(f"  page /{slug}: {len(sections)} sections, {sum(len(s['blocks']) for s in sections)} blocks")

def save(kind, slug, doc):
    f = os.path.join(CONTENT, kind, slug.replace("/", "__") + ".json")
    os.makedirs(os.path.dirname(f), exist_ok=True)
    json.dump(doc, open(f, "w"), indent=1, ensure_ascii=False)

# ---------------------------------------------------------------- collections
def local(ms): return datetime.datetime.fromtimestamp(ms / 1000, TZ)

def migrate_sermons():
    items = json.load(open(os.path.join(CAP, "podcast_all.json")))
    os.makedirs(os.path.join(ROOT, "audio"), exist_ok=True)
    used = set(); n_audio = 0; summaries = {}
    rss = os.path.join(CAP, "podcast.rss")
    if os.path.exists(rss):
        for it in re.findall(r"<item>(.*?)</item>", open(rss).read(), flags=re.S):
            l = re.search(r"<link>([^<]+)</link>", it); dsc = re.search(r"<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</description>", it, flags=re.S)
            if l and dsc: summaries[l.group(1).rstrip("/").rsplit("/", 1)[-1]] = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", dsc.group(1)))).strip()
    for i in items:
        slug = i["urlId"].split("/")[-1]; body = i.get("body") or ""
        pub = local(i["publishOn"]); date = None
        m = re.search(r'data-asset-url="([^"]+)"', body)
        if m:
            d = re.search(r"(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})", urllib.parse.unquote(m.group(1).rsplit("/", 1)[-1]))
            if d:
                try:
                    y = int(d.group(3)); y += 2000 if y < 100 else 0
                    cand = datetime.date(y, int(d.group(1)), int(d.group(2)))
                    if abs((cand - pub.date()).days) < 60: date = cand
                except ValueError: pass
        if not date: date = pub.date() - datetime.timedelta(days=(pub.weekday() + 1) % 7)  # the Sunday before publishing
        doc = {"title": unescape(i["title"]).strip(), "slug": slug, "date": date.isoformat(), "published": pub.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "speaker": "", "scripture": "", "description": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", i.get("excerpt") or "")).strip(),
               "audio": "", "video": "", "body": "", "guid": f"{i.get('websiteId', '61816ab5972826552e67eec6')}:{i['collectionId']}:{i['id']}"}
        if not doc["description"]: doc["description"] = summaries.get(slug, "")
        a = re.search(r'data-author="([^"]*)"', body); L = re.search(r'data-length-in-milli-seconds="(\d+)"', body)
        if a: doc["speaker"] = a.group(1).replace("&amp;", "&").strip()
        if L: doc["duration"] = int(L.group(1)) // 1000
        src = os.path.join(CAP, "audio", slug + ".mp3")
        if m and os.path.exists(src):
            name = f"sermon-{date.isoformat()}.mp3"; k = 2
            while name in used: name = f"sermon-{date.isoformat()}-{k}.mp3"; k += 1
            used.add(name); dest = os.path.join(ROOT, "audio", name)
            if not os.path.exists(dest): shutil.copy2(src, dest)
            doc["audio"] = name; doc["audioBytes"] = os.path.getsize(dest); n_audio += 1
        tree = parse(body); extra = []
        for b in tree.by_class("sqs-block"):
            kind = (b.attrs.get("data-definition-name") or "").replace("website.components.", "")
            if kind == "html":
                c = b.first_class("sqs-html-content") or b; h = clean(c)
                if h: extra.append(h)
            elif kind in ("video", "embed", "code"):
                fr = b.find(lambda n: n.tag == "iframe")
                js = b.find(lambda n: "data-block-json" in n.attrs)
                srcs = (fr.attrs.get("src", "") if fr else "") + (js.attrs.get("data-block-json", "") if js else "")
                v = re.search(r"(?:youtu\.be/|v=|embed/)([\w-]{11})", srcs)
                if v: doc["video"] = "https://www.youtube.com/watch?v=" + v.group(1)
        v = re.search(r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/))([\w-]{11})", body)
        if v and not doc["video"]: doc["video"] = "https://www.youtube.com/watch?v=" + v.group(1)
        doc["body"] = "".join(extra)
        if doc["body"] and re.sub(r"<[^>]+>", "", doc["body"]).strip() == doc["description"]: doc["body"] = ""
        save("sermons", slug, doc)
    print(f"  sermons: {len(items)} ({n_audio} with audio)")

def migrate_events():
    d = json.load(open(os.path.join(CAP, "pages", "upcoming.json")))
    redirects = {}
    for i in d.get("past", []): redirects["/" + i["fullUrl"].strip("/")] = "/events/"
    for i in d.get("upcoming", []):
        slug = i["urlId"].split("/")[-1]; s, e = local(i["startDate"]), local(i["endDate"])
        loc = i.get("location") or {}
        where = ", ".join(x for x in [loc.get("addressTitle"), loc.get("addressLine1"), loc.get("addressLine2")] if x)
        body = "".join(clean(b.first_class("sqs-html-content") or b) for b in parse(i.get("body") or "").by_class("sqs-block") if "html" in (b.attrs.get("data-definition-name") or ""))
        doc = {"title": unescape(i["title"]).strip(), "slug": slug, "start": s.strftime("%Y-%m-%dT%H:%M"), "end": e.strftime("%Y-%m-%dT%H:%M"), "allDay": False, "location": where,
               "image": image(i.get("assetUrl", ""), 1500), "summary": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", i.get("excerpt") or "")).strip(), "body": body, "buttonLabel": "", "buttonHref": ""}
        save("events", slug, doc)
    live = {i["urlId"].split("/")[-1] for i in d.get("upcoming", [])}
    for loc in re.findall(r"<loc>https://www\.sp4u\.org(/upcoming/[^<]+)</loc>", open(os.path.join(CAP, "sitemap.xml")).read()):
        if loc.rsplit("/", 1)[-1] not in live: redirects[loc] = "/events/"
    print(f"  events: {len(d.get('upcoming', []))} upcoming migrated, {len(redirects)} past redirected")
    return redirects

# ---------------------------------------------------------------- site settings
def migrate_site(redirects):
    home = open(os.path.join(CAP, "html", "home.html")).read()
    logo = image("https://images.squarespace-cdn.com/content/v1/61816ab5972826552e67eec6/0d118ee3-a28f-431a-9217-210c5b54a49c/SP+LEAF+LEFT+white+letters.png", 750)
    foot = parse(home[home.find("<footer"):home.find("</footer>") + 9])
    badge = ""
    for im in foot.find_all(lambda n: n.tag == "img"):
        badge = image(im.attrs.get("data-src") or im.attrs.get("src"), 500) or badge
    pod = image("https://images.squarespace-cdn.com/content/v1/61816ab5972826552e67eec6/1731444589812-V71QMCZOFU27298SQ2DS/podcastlogo.jpg", 1500)
    redirects.update({"/home": "/", "/volunteer": "/volunteer-at-stpauls/", "/upcoming": "/events/", "/ministries": "/outreach/", "/cart": "/",
                      "/choir/7-day-morning-flow-challenge": "/choir/", "/choir/mindful-meditation": "/choir/", "/choir/yoga-for-beginners": "/choir/"})
    for f in os.listdir(os.path.join(CAP, "pages")):
        if f.startswith("choir__v__"): redirects["/choir/v/" + f[10:-5]] = "/choir/"
    site = {
        "title": "St. Paul's United Church of Christ", "description": "A place of worship, refuge, and outreach in Oakville, Missouri. Join us Sundays at 9:00 and 10:45 am.",
        "url": "https://www.sp4u.org", "cname": "www.sp4u.org", "logo": logo, "favicon": "", "shareImage": "",
        "header": {"theme": "accent", "sticky": True, "logoHeight": 56, "ctaLabel": "Plan a Visit", "ctaHref": "/new-guests"},
        "nav": [
            {"label": "About", "href": "", "children": [{"label": "About Us", "href": "/about"}, {"label": "New Guests", "href": "/new-guests"}, {"label": "Our Beliefs", "href": "/our-beliefs"}, {"label": "Our Leadership", "href": "/leadership"}, {"label": "Events", "href": "/events"}]},
            {"label": "Ministries", "href": "", "children": [{"label": "Outreach", "href": "/outreach"}, {"label": "Volunteer", "href": "/volunteer-at-stpauls"}, {"label": "Choir", "href": "/choir"}, {"label": "Adult Ministry", "href": "/adult-ministry"}, {"label": "Youth Ministry", "href": "/youth-ministry"}, {"label": "Children's Ministry", "href": "/childrens-ministry"}, {"label": "St. Paul Cemetery", "href": "https://www.findagrave.com/cemetery/31386/saint-paul-cemetery"}, {"label": "Podcast", "href": "/podcast"}, {"label": "Give", "href": "/giving"}]},
            {"label": "TreeHouse", "href": "", "children": [{"label": "TreeHouse Home", "href": "/treehouse"}, {"label": "About TreeHouse", "href": "/treehouse/about"}, {"label": "Enrollment Information", "href": "/treehouse/enroll"}]},
            {"label": "Contact Us", "href": "/contact-us", "children": []}],
        "footer": {"theme": "dark", "showSocial": True, "socialTitle": "Follow Us", "badge": badge, "badgeHref": "https://www.ucc.org", "badgeAlt": "United Church of Christ",
                   "columns": [{"title": "Contact Us", "html": "<p><a href=\"tel:+13148923332\">(314) 892-3332</a></p><p>5508 Telegraph Road<br>Oakville, MO 63129</p>"},
                               {"title": "Sunday Worship", "html": "<p>9:00 am · Heritage (Traditional)<br>10:45 am · Connections (Contemporary)</p><p><a href=\"/new-guests\">Plan a visit</a></p>"}],
                   "note": "© {year} St. Paul's United Church of Christ"},
        "social": [{"type": "facebook", "label": "Facebook", "href": "https://www.facebook.com/stpauloakville"}, {"type": "instagram", "label": "Instagram", "href": "https://www.instagram.com/stpauloakville/"},
                   {"type": "youtube", "label": "YouTube", "href": "https://www.youtube.com/channel/UCrbUrKU7f3Lqznyqia2IBeQ"}, {"type": "spotify", "label": "Spotify", "href": "https://open.spotify.com/show/5QKY2vEayubUT6AP5EKXwL"}],
        "announcement": {"enabled": False, "text": "", "href": "", "theme": "dark"},
        "podcast": {"title": "St. Paul's UCC Podcast", "description": "Weekly Sermons from Pastors Mike and Erica at St. Paul’s United Church of Christ in Oakville, MO. Join us Sundays at 9:00 and 10:45.",
                    "author": "St. Paul's UCC", "ownerName": "St. Paul's UCC", "ownerEmail": "media@sp4u.org", "image": pod, "audioBase": "/audio/"},
        "styles": {
            "colors": {"accent": "#00624f", "accentDark": "#06443a", "gold": "#c79a3b", "dark": "#24211f", "mid": "#66605c", "light": "#f4f1ec", "white": "#ffffff"},
            "themes": {"white": {"bg": "white", "text": "#3a3633", "heading": "dark", "accent": "accent", "buttonBg": "accent", "buttonText": "white"},
                       "light": {"bg": "light", "text": "#3a3633", "heading": "dark", "accent": "accent", "buttonBg": "accent", "buttonText": "white"},
                       "accent": {"bg": "accent", "text": "#e6f1ee", "heading": "white", "accent": "white", "buttonBg": "white", "buttonText": "accent"},
                       "dark": {"bg": "dark", "text": "#e9e5e0", "heading": "white", "accent": "#8fd3c2", "buttonBg": "white", "buttonText": "dark"}},
            "fonts": {"heading": {"family": "Fraunces", "fallback": "Georgia, serif", "weight": 500, "spacing": -0.02, "lineHeight": 1.15, "transform": "none"},
                      "body": {"family": "Lato", "fallback": "Helvetica, Arial, sans-serif", "weight": 400, "lineHeight": 1.65},
                      "button": {"family": "Lato", "fallback": "Helvetica, Arial, sans-serif", "weight": 700, "transform": "uppercase", "spacing": 0.06, "size": 0.9}},
            "sizes": {"h1": 3.8, "h2": 2.7, "h3": 1.75, "h4": 1.25, "body": 1.08},
            "buttons": {"radius": 6, "padX": 1.7, "padY": 0.95, "border": 2},
            "layout": {"maxWidth": 1240, "radius": 10, "sectionPad": 72}},
        "redirects": redirects}
    json.dump(site, open(os.path.join(CONTENT, "site.json"), "w"), indent=1, ensure_ascii=False)

PAGES = [("home", "Home"), ("about", "About Us"), ("new-guests", "New Guests"), ("our-beliefs", "Our Beliefs"), ("leadership", "Our Leadership"), ("events", "Events"),
         ("outreach", "Outreach"), ("volunteer-at-stpauls", "Volunteer"), ("choir", "Choir"), ("adult-ministry", "Adult Ministry"), ("youth-ministry", "Youth Ministry"),
         ("childrens-ministry", "Children's Ministry"), ("podcast", "Sermon Podcast"), ("giving", "Give"), ("treehouse", "TreeHouse"), ("treehouse/about", "About TreeHouse"),
         ("treehouse/enroll", "TreeHouse Enrollment"), ("contact-us", "Contact Us"), ("teams", "Teams"), ("connect", "Connect"), ("check-in", "Check In")]

if __name__ == "__main__":
    only = sys.argv[1:]
    os.makedirs(MEDIA, exist_ok=True)
    if not only or "pages" in only:
        for slug, title in PAGES: migrate_page(slug, title, hidden=slug in ("teams", "connect", "check-in"))
    if not only or "pages" in only: polish()
    if not only or "sermons" in only: migrate_sermons()
    if not only or "site" in only: migrate_site(migrate_events())
    for n in sorted(set(notes)): print("  NOTE:", n, f"(x{notes.count(n)})" if notes.count(n) > 1 else "")
