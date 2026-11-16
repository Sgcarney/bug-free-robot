// Cloudflare Pages Function for the home page ("/").
// Substack refuses requests from GitHub's servers, so the "Latest posts" list is
// filled in here instead: on each visit, Cloudflare reads the Substack feed (cached
// for an hour) and swaps the newest posts into <ul class="posts">. If Substack can't
// be read, the page is served exactly as built, with the list already in the HTML.

const FEED = "https://sgcarney.substack.com/feed";
const ARCHIVE = "https://sgcarney.substack.com/api/v1/archive?sort=new&limit=8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CACHE_KEY = "https://scottcarney.com/__cache/substack-posts-v1";
const TTL = 3600;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&amp;/g, "&").trim();
const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

function fromFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, e]) => ({
    link: tag(e, "link"), title: tag(e, "title"),
    sub: tag(e, "description").replace(/<[^>]+>/g, ""), date: tag(e, "pubDate"),
  }));
}
function fromArchive(list) {
  return list.map((p) => ({ link: p.canonical_url, title: p.title, sub: p.subtitle || p.description || "", date: p.post_date }));
}

function render(posts) {
  return posts
    .filter((p) => p.link && p.title && !isNaN(new Date(p.date)))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5)
    .map((p) => {
      const d = new Date(p.date);
      return `<li><a href="${esc(p.link)}"><time datetime="${d.toISOString().slice(0, 10)}">${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}</time><div><strong>${esc(p.title)}</strong><span>${esc(clip(p.sub, 90))}</span></div></a></li>`;
    })
    .join("\n");
}

async function latestPostsHtml(ctx) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit.text();

  let html = "";
  try {
    const r = await fetch(FEED, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" } });
    if (r.ok) html = render(fromFeed(await r.text()));
  } catch {}
  if (!html) {
    try {
      const r = await fetch(ARCHIVE, { headers: { "user-agent": UA, accept: "application/json" } });
      if (r.ok) html = render(fromArchive(await r.json()));
    } catch {}
  }
  if (html) {
    ctx.waitUntil(cache.put(CACHE_KEY, new Response(html, { headers: { "cache-control": `public, max-age=${TTL}` } })));
  }
  return html;
}

export async function onRequestGet(ctx) {
  const page = await ctx.next();
  if (!(page.headers.get("content-type") || "").includes("text/html")) return page;

  let posts = "";
  try { posts = await latestPostsHtml(ctx); } catch {}
  if (!posts) return page;

  return new HTMLRewriter()
    .on("ul.posts", { element(el) { el.setInnerContent(posts, { html: true }); } })
    .transform(page);
}
