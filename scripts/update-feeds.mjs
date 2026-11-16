// Refreshes the "Latest investigations on video" and "Latest posts" blocks on
// the home page from the YouTube and Substack feeds. Run by
// .github/workflows/update-feeds.yml on a schedule; a push to main makes
// Cloudflare Pages redeploy. If a feed can't be read, that block is left as is.
//
// Local test: YT_FEED_FILE=x.xml SUBSTACK_FEED_FILE=y.xml node scripts/update-feeds.mjs

import { readFile, writeFile } from "node:fs/promises";

const CHANNEL_ID = "UC3PyxGKt94kLzVqkkjEgRFw";
// "UULF" + channel id (minus "UC") = long-form uploads only, so Shorts don't show up.
const YT_FEED = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${CHANNEL_ID.slice(2)}`;
const SUBSTACK_FEED = "https://sgcarney.substack.com/feed";
const PAGE = new URL("../index.html", import.meta.url);
const UA = "Mozilla/5.0 (compatible; scottcarney.com feed updater; +https://scottcarney.com)";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function getFeed(url, file) {
  if (file) return readFile(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&amp;/g, "&").trim();
const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const shortDate = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

function firstLine(desc) {
  const line = desc.split(/\n/).map((l) => l.trim())
    .find((l) => l && !/^https?:\/\//i.test(l) && !/^(sponsor|thanks to|this video is sponsored|subscribe|join|support)/i.test(l)) || "";
  return clip(line.replace(/https?:\/\/\S+/g, "").trim(), 110);
}

function parseVideos(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    meta: firstLine(tag(e, "media:description")),
    date: new Date(tag(e, "published")),
  })).filter((v) => v.id && v.title).sort((a, b) => b.date - a.date);
}

function parsePosts(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, e]) => ({
    link: tag(e, "link"),
    title: tag(e, "title"),
    sub: clip(tag(e, "description").replace(/<[^>]+>/g, ""), 90),
    date: new Date(tag(e, "pubDate")),
  })).filter((p) => p.link && p.title).sort((a, b) => b.date - a.date);
}

function thumb(id, big) {
  // maxres doesn't exist for every video; fall back to hq if it 404s.
  const src = `https://i.ytimg.com/vi/${id}/${big ? "maxresdefault" : "mqdefault"}.jpg`;
  const fb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return `<img src="${src}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fb}'">`;
}

function renderVideos(v) {
  const [top, ...rest] = v;
  const side = rest.slice(0, 3).map((x) => `
          <a class="vid" href="https://www.youtube.com/watch?v=${esc(x.id)}">
            <div class="thumb">${thumb(x.id, false)}<span class="play">▶</span></div>
            <div><h3>${esc(x.title)}</h3><span class="meta">${esc(x.meta)}</span></div>
          </a>`).join("");
  return `
      <div class="videos">
        <a class="vid big" href="https://www.youtube.com/watch?v=${esc(top.id)}">
          <div class="thumb">${thumb(top.id, true)}<span class="play">▶ Newest</span></div>
          <h3>${esc(top.title)}</h3>
          <span class="meta">${esc(top.meta)}</span>
        </a>
        <div class="side">${side}
        </div>
      </div>
`;
}

function renderPosts(p) {
  const items = p.slice(0, 5).map((x) =>
    `          <li><a href="${esc(x.link)}"><time datetime="${x.date.toISOString().slice(0, 10)}">${shortDate(x.date)}</time><div><strong>${esc(x.title)}</strong><span>${esc(x.sub)}</span></div></a></li>`).join("\n");
  return `
        <ul class="posts">
${items}
        </ul>
`;
}

function swap(html, key, body) {
  const re = new RegExp(`(<!-- AUTO:${key}:START -->)[\\s\\S]*?(\\n[ \\t]*<!-- AUTO:${key}:END -->)`);
  if (!re.test(html)) throw new Error(`markers for ${key} not found in index.html`);
  return html.replace(re, `$1${body.replace(/\n$/, "")}$2`);
}

let html = await readFile(PAGE, "utf8");
const before = html;

try {
  const videos = parseVideos(await getFeed(YT_FEED, process.env.YT_FEED_FILE));
  if (videos.length >= 4) { html = swap(html, "VIDEOS", renderVideos(videos)); console.log(`videos: newest is "${videos[0].title}"`); }
  else console.warn(`videos: only ${videos.length} found, leaving block unchanged`);
} catch (e) { console.warn(`videos: ${e.message}; leaving block unchanged`); }

// Substack sometimes refuses cloud servers (HTTP 403) on /feed. Try the feed with a
// browser user agent, then Substack's own archive API, and use the first that works.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function getPosts() {
  if (process.env.SUBSTACK_FEED_FILE) return parsePosts(await readFile(process.env.SUBSTACK_FEED_FILE, "utf8"));
  const errors = [];
  for (const ua of [UA, BROWSER_UA]) {
    try {
      const res = await fetch(SUBSTACK_FEED, { headers: { "user-agent": ua, accept: "application/rss+xml, application/xml, text/xml" } });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      const posts = parsePosts(await res.text());
      if (posts.length) return posts;
      throw new Error("feed had no posts");
    } catch (e) { errors.push(e.message); }
  }
  try {
    const res = await fetch("https://sgcarney.substack.com/api/v1/archive?sort=new&limit=8", { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
    if (!res.ok) throw new Error(`archive API HTTP ${res.status}`);
    const list = await res.json();
    const posts = list.filter((p) => p.canonical_url && p.title).map((p) => ({
      link: p.canonical_url, title: p.title, sub: clip(p.subtitle || p.description || "", 90), date: new Date(p.post_date),
    })).sort((a, b) => b.date - a.date);
    if (posts.length) return posts;
    throw new Error("archive API had no posts");
  } catch (e) { errors.push(e.message); }
  throw new Error(errors.join("; "));
}

try {
  const posts = await getPosts();
  if (posts.length) { html = swap(html, "POSTS", renderPosts(posts)); console.log(`posts: newest is "${posts[0].title}"`); }
  else console.warn("posts: none found, leaving block unchanged");
} catch (e) { console.warn(`posts: ${e.message}; leaving block unchanged`); }

if (html !== before) { await writeFile(PAGE, html); console.log("index.html updated"); }
else console.log("no changes");
