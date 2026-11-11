"""One-off capture of the old Squarespace site: page JSON, sitemap, CSS."""
import json, os, re, subprocess, sys
BASE = "https://www.sp4u.org"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_capture")
def get(url, binary=False):
    r = subprocess.run(["curl", "-sL", "-A", "Mozilla/5.0", url], capture_output=True)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")
sm = get(BASE + "/sitemap.xml")
open(os.path.join(OUT, "sitemap.xml"), "w").write(sm)
locs = re.findall(r"<loc>([^<]+)</loc>", sm)
paths = sorted(set(l.replace(BASE, "") or "/" for l in locs if l.startswith(BASE)))
paths += ["/", "/giving", "/leadership", "/volunteer", "/upcoming"]
paths = sorted(set(p for p in paths if not p.startswith("/podcast/")))
ok = 0
for p in paths:
    name = (p.strip("/").replace("/", "__") or "index")
    raw = get(BASE + p + "?format=json")
    try:
        json.loads(raw)
    except Exception:
        print("not json:", p); continue
    open(os.path.join(OUT, "pages", name + ".json"), "w").write(raw); ok += 1
print("pages captured", ok, "of", len(paths))
html = get(BASE + "/")
open(os.path.join(OUT, "home.html"), "w").write(html)
css = re.findall(r'href="([^"]+\.css[^"]*)"', html)
print("css links", css[:6])
for i, c in enumerate(css[:6]):
    u = c if c.startswith("http") else ("https:" + c if c.startswith("//") else BASE + c)
    open(os.path.join(OUT, f"style{i}.css"), "w").write(get(u))
