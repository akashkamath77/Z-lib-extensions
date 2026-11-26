const DEFAULT_BASE = "https://z-lib.gd";
const MAX_RESULTS = 50;

function xml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[c]);
}
function decode(value = "") {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function attr(source, name) {
  const match = source.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(['\\"])(.*?)\\1", "i"));
  return match ? decode(match[2]) : "";
}
function cleanText(source = "") {
  return decode(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
function absolute(path, base) {
  const url = new URL(path, base);
  if (url.protocol !== "https:" || url.hostname !== new URL(base).hostname) {
    throw new Error("The catalogue returned an unexpected external link.");
  }
  return url.href;
}
function keyFrom(request) {
  return new URL(request.url).searchParams.get("key") || "";
}
function auth(request, env) {
  if (!env.OPDS_KEY || keyFrom(request) !== env.OPDS_KEY) {
    return new Response("Unauthorized. Configure the OPDS key in Readest.", { status: 401 });
  }
}
async function upstream(url, env) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/epub+zip,*/*"
  };
  if (env.ZLIB_COOKIE) headers.Cookie = env.ZLIB_COOKIE;
  return fetch(url, { headers, redirect: "follow" });
}
function feed(title, self, entries, key, extra = "") {
  const root = new URL(self);
  const keyParam = key ? "&key=" + encodeURIComponent(key) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xml(root.origin + root.pathname + root.search)}</id>
  <title>${xml(title)}</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${xml(self)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="/opds?key=${encodeURIComponent(key)}" type="application/atom+xml;profile=opds-catalog"/>
  ${extra}
  ${entries.join("\n")}
</feed>`;
}
function entry(book, base, key) {
  const bookUrl = "/opds/book?path=" + encodeURIComponent(book.path) + "&key=" + encodeURIComponent(key);
  const cover = book.cover ? `<link rel="http://opds-spec.org/image" href="${xml(book.cover)}" type="image/jpeg"/><link rel="http://opds-spec.org/image/thumbnail" href="${xml(book.cover)}" type="image/jpeg"/>` : "";
  return `<entry>
    <title>${xml(book.title)}</title>
    <id>${xml(base + book.path)}</id>
    <updated>${new Date().toISOString()}</updated>
    ${book.author ? `<author><name>${xml(book.author)}</name></author>` : ""}
    ${book.publisher ? `<publisher>${xml(book.publisher)}</publisher>` : ""}
    ${book.year ? `<dcterms:issued xmlns:dcterms="http://purl.org/dc/terms/">${xml(book.year)}</dcterms:issued>` : ""}
    ${cover}
    <link rel="subsection" href="${xml(bookUrl)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>`;
}
function parseCards(html, base) {
  const books = [];
  const seen = new Set();
  const re = /<z-bookcard\b([^>]*)>([\s\S]*?)<\/z-bookcard>/gi;
  let match;
  while ((match = re.exec(html)) && books.length < MAX_RESULTS) {
    const attrs = match[1], body = match[2];
    const href = attr(attrs, "href");
    const titleMatch = body.match(/<[^>]*slot=["']title["'][^>]*>([\s\S]*?)<\/[\w:-]+>/i);
    const title = cleanText(titleMatch?.[1] || attr(attrs, "title"));
    if (!href || !title) continue;
    let path;
    try {
      const url = new URL(href, base);
      if (url.hostname !== new URL(base).hostname || !url.pathname.startsWith("/book/")) continue;
      path = url.pathname;
    } catch { continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const image = body.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/i);
    let cover = "";
    try { if (image) cover = absolute(decode(image[1]), base); } catch {}
    books.push({ title, path, cover, author: "", publisher: "", year: "" });
  }
  return books;
}
function parseDetails(html, path, base) {
  const title = cleanText(html.match(/<h1[^>]*class=["'][^"']*book-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const author = cleanText(html.match(/class=["'][^"']*authors[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const publisher = cleanText(html.match(/class=["'][^"']*property_publisher[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*property_value[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const year = cleanText(html.match(/class=["'][^"']*property_year[^"']*["'][^>]*>[\s\S]*?class=["'][^"']*property_value[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || "");
  const coverMatch = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/i);
  let cover = "";
  try { if (coverMatch) cover = new URL(decode(coverMatch[1]), base).href; } catch {}
  const download = html.match(/href=["'](\/dl\/[^"'?#]+)["']/i)?.[1] || "";
  return { title, author, publisher, year, cover, download, path };
}
function errorPage(response, body) {
  if (response.status === 503 || /checking your browser|just a moment|captcha|verify you are human/i.test(body)) {
    return new Response("Z-Library returned a browser verification page to the cloud host. This deployment cannot complete that check automatically. Try again later or use a permitted authenticated route.", { status: 502 });
  }
  return new Response("Z-Library returned HTTP " + response.status, { status: 502 });
}
export default {
  async fetch(request, env) {
    const denied = auth(request, env);
    if (denied) return denied;
    const u = new URL(request.url);
    const key = keyFrom(request);
    const base = (env.ZLIB_BASE || DEFAULT_BASE).replace(/\/$/, "");
    const keySuffix = "?key=" + encodeURIComponent(key);
    const xmlHeaders = { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "no-store" };

    if (u.pathname === "/opds" || u.pathname === "/") {
      const entries = [
        `<entry><title>Search Z-Library</title><id>urn:readest-zlib:search</id><updated>${new Date().toISOString()}</updated><content type="text">Search the catalogue</content><link rel="search" href="/opds/search.xml?key=${encodeURIComponent(key)}" type="application/opensearchdescription+xml"/></entry>`,
      ];
      return new Response(feed("Z-Library", u.origin + "/opds" + keySuffix, entries, key), { headers: xmlHeaders });
    }

    if (u.pathname === "/opds/search.xml") {
      const description = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Z-Library</ShortName>
  <Description>Search Z-Library</Description>
  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${xml(u.origin)}/opds/search?q={searchTerms}&amp;key=${encodeURIComponent(key)}"/>
</OpenSearchDescription>`;
      return new Response(description, { headers: { "Content-Type": "application/opensearchdescription+xml; charset=utf-8" } });
    }

    if (u.pathname === "/opds/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q || q.length > 160) return new Response("Provide a search term (1–160 characters).", { status: 400 });
      const target = base + "/s/" + encodeURIComponent(q);
      const response = await upstream(target, env);
      const html = await response.text();
      if (!response.ok) return errorPage(response, html);
      const books = parseCards(html, base);
      const entries = books.map(book => entry(book, base, key));
      return new Response(feed("Search: " + q, u.origin + "/opds/search?q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(key), entries, key), { headers: xmlHeaders });
    }

    if (u.pathname === "/opds/book") {
      const path = u.searchParams.get("path") || "";
      if (!/^\/book\/[^/]+\/.+\.html$/.test(path)) return new Response("Invalid book path.", { status: 400 });
      const response = await upstream(base + path, env);
      const html = await response.text();
      if (!response.ok) return errorPage(response, html);
      const book = parseDetails(html, path, base);
      if (!book.title) return new Response("Could not parse the book details page.", { status: 502 });
      const links = [];
      if (book.download) links.push(`<link rel="http://opds-spec.org/acquisition" href="/opds/download?path=${encodeURIComponent(book.download)}&amp;key=${encodeURIComponent(key)}" type="application/epub+zip" title="Download"/>`);
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<title>${xml(book.title)}</title><id>${xml(base + path)}</id><updated>${new Date().toISOString()}</updated>
<entry><title>${xml(book.title)}</title><id>${xml(base + path)}</id><updated>${new Date().toISOString()}</updated>
${book.author ? `<author><name>${xml(book.author)}</name></author>` : ""}
${book.publisher ? `<publisher>${xml(book.publisher)}</publisher>` : ""}
${book.cover ? `<link rel="http://opds-spec.org/image" href="${xml(book.cover)}" type="image/jpeg"/>` : ""}
${links.join("")}
<content type="text">${xml([book.author, book.publisher, book.year].filter(Boolean).join(" · "))}</content>
</entry></feed>`;
      return new Response(body, { headers: xmlHeaders });
    }

    if (u.pathname === "/opds/download") {
      const path = u.searchParams.get("path") || "";
      if (!/^\/dl\/[A-Za-z0-9_-]+$/.test(path)) return new Response("Invalid download path.", { status: 400 });
      const response = await upstream(base + path, env);
      if (!response.ok) {
        const body = await response.text();
        return errorPage(response, body);
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.delete("set-cookie");
      return new Response(response.body, { status: response.status, headers });
    }
    return new Response("Not found", { status: 404 });
  }
};