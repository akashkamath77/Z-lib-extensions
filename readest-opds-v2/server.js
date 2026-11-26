const http = require("node:http");
const { createHash, timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");

const DEFAULT_BASE = "https://z-lib.gd";
const MAX_RESULTS = 40;
const challengeCookies = new Map();

function xml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[c]);
}
function decode(value = "") {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function cleanText(value = "") {
  return decode(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
function attr(source = "", name) {
  const match = source.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(['\"])(.*?)\\1", "i"));
  return match ? decode(match[2]) : "";
}
function allowedBookPath(path) {
  return /^\/book\/[^/]+\/.+\.html$/i.test(path);
}
function formatMime(format) {
  return ({
    epub: "application/epub+zip", pdf: "application/pdf",
    mobi: "application/x-mobipocket-ebook", azw3: "application/vnd.amazon.ebook",
    fb2: "application/x-fictionbook+xml", djvu: "image/vnd.djvu",
    txt: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    rtf: "application/rtf", html: "text/html",
    cbz: "application/vnd.comicbook+zip", cbr: "application/vnd.comicbook-rar"
  })[format] || "application/octet-stream";
}
function isBrowserCheck(body) {
  return /<title[^>]*>\s*(?:Checking your browser|Just a moment|Access denied|Attention required)/i.test(body);
}
function solveBrowserCheck(body) {
  const seedMatch = body.match(/\['([0-9a-f]{32,128})','c_token=','array'\]/i);
  const target = body.match(/s\s*\[\s*n1\s*\]\s*===\s*0x([0-9a-f]+).*?s\s*\[\s*n1\s*\+\s*0x1\s*\]\s*===\s*0x([0-9a-f]+)/i);
  if (!seedMatch || !target || !body.includes("c_time=")) {
    throw new Error("Unsupported Z-Library browser-check format.");
  }
  const seed = seedMatch[1];
  const offset = parseInt(seed[0], 16);
  const first = parseInt(target[1], 16);
  const second = parseInt(target[2], 16);
  if (offset >= 19 || first > 255 || second > 255) throw new Error("Invalid browser-check parameters.");
  const started = Date.now();
  for (let nonce = 0; nonce < 1000000; nonce++) {
    const digest = createHash("sha1").update(seed + nonce, "ascii").digest();
    if (digest[offset] === first && digest[offset + 1] === second) {
      return "c_token=" + seed + nonce + "; c_time=" + ((Date.now() - started) / 1000);
    }
    if (nonce > 0 && nonce % 4096 === 0 && Date.now() - started > 15000) break;
  }
  throw new Error("Browser-check computation exceeded 15 seconds or one million attempts.");
}

async function upstream(input, env, init = {}) {
  let current = new URL(input);
  let method = init.method || "GET";
  let body = init.body;
  let challengeRetried = false;
  for (let hop = 0; hop < 7; hop++) {
    const headers = new Headers(init.headers || {});
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36");
    headers.set("Accept", "text/html,application/xhtml+xml,application/epub+zip,*/*");
    const configuredBase = new URL(env.ZLIB_BASE || DEFAULT_BASE);
    const bookOrigin = current.origin === configuredBase.origin;
    const readerOrigin = /^https:\/\/reader\.z-lib\.(?:do|gd)$/i.test(current.origin);
    const challengeCookie = challengeCookies.get(current.origin);
    const cookies = [];
    if (bookOrigin && env.ZLIB_COOKIE) cookies.push(env.ZLIB_COOKIE);
    if ((bookOrigin || readerOrigin) && challengeCookie) cookies.push(challengeCookie);
    if (cookies.length) headers.set("Cookie", cookies.join("; "));
    else headers.delete("Cookie");

    const response = await fetch(current, { method, headers, body, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new Error("Upstream attempted an insecure redirect.");
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      current = next;
      continue;
    }

    const type = response.headers.get("content-type") || "";
    if (!challengeRetried && (response.status === 503 || /text\/html/i.test(type))) {
      const html = await response.clone().text();
      if (isBrowserCheck(html)) {
        if (!bookOrigin && !readerOrigin) throw new Error("Browser challenge came from an unexpected host.");
        challengeCookies.set(current.origin, solveBrowserCheck(html));
        challengeRetried = true;
        continue;
      }
    }
    if (challengeRetried && (response.status === 503 || (response.headers.get("content-type") || "").includes("text/html")) && isBrowserCheck(await response.clone().text())) {
      challengeCookies.delete(current.origin);
      throw new Error("Z-Library did not accept the browser-check response.");
    }
    return response;
  }
  throw new Error("Too many upstream redirects.");
}

function parseCards(html, base) {
  const books = [];
  const seen = new Set();
  const add = (href, title, image) => {
    if (!href || !title) return;
    try {
      const url = new URL(href, base);
      if (url.origin !== new URL(base).origin || !allowedBookPath(url.pathname) || seen.has(url.pathname)) return;
      const cleanTitle = cleanText(title);
      if (!cleanTitle) return;
      seen.add(url.pathname);
      let cover = "";
      if (image && !/^(?:data:|blob:)/i.test(image)) {
        const img = new URL(image, base);
        if (img.protocol === "https:") cover = img.href;
      }
      books.push({ title: cleanTitle, path: url.pathname, cover });
    } catch {}
  };

  const cards = /<z-bookcard\b([^>]*)>([\s\S]*?)<\/z-bookcard>/gi;
  let match;
  while ((match = cards.exec(html)) && books.length < MAX_RESULTS) {
    const body = match[2];
    const title = body.match(/<[^>]*slot=['"]title['"][^>]*>([\s\S]*?)<\/[\w:-]+>/i);
    const image = body.match(/<z-cover\b[^>]*>[\s\S]*?<img\b([^>]*)>/i) || body.match(/<img\b([^>]*)>/i);
    const imageSource = image ? (attr(image[1], "src") || attr(image[1], "data-src")) : "";
    add(attr(match[1], "href"), title ? title[1] : attr(match[1], "title"), imageSource || attr(match[1], "cover"));
  }

  if (!books.length) {
    const links = /<a\b([^>]*href=['"]([^'"]*\/book\/[^'"]+)['"][^>]*)>([\s\S]*?)<\/a>/gi;
    while ((match = links.exec(html)) && books.length < MAX_RESULTS) {
      const img = match[3].match(/<img\b[^>]*(?:data-src|src)=['"]([^'"]+)['"][^>]*>/i);
      const cover = match[3].match(/<z-cover\b[^>]*title=['"]([^'"]+)['"]/i);
      add(match[2], cover ? cover[1] : attr(match[1], "title") || cleanText(match[3]), img ? img[1] : "");
    }
  }
  if (!books.length && /nothing (?:has been|was) found|no (?:books|results) found|no results matching/i.test(cleanText(html))) return [];
  if (!books.length) throw new Error("Search page contained no recognizable book cards. Z-Library may have changed its page layout.");
  return books;
}

function parseDetails(html, path, base) {
  const title = cleanText(html.match(/<h1[^>]*class=['"][^'"]*book-title[^'"]*['"][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const author = cleanText(html.match(/<i[^>]*class=['"][^'"]*\bauthors\b[^'"]*['"][^>]*>([\s\S]*?)<\/i>/i)?.[1] || "");

  // Z-Library exposes the complete book record as Schema.org JSON-LD.
  let schema = {};
  for (const match of html.matchAll(/<script\b[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const candidate = JSON.parse(match[1].trim());
      const records = Array.isArray(candidate) ? candidate : [candidate];
      schema = records.find(item => item && item["@type"] === "Book") || schema;
      if (schema["@type"] === "Book") break;
    } catch {}
  }

  const properties = {};
  const propertyBlocks = /<div\b([^>]*class=['"][^'"]*\bbookProperty\b[^'"]*['"][^>]*)>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let propertyMatch;
  while ((propertyMatch = propertyBlocks.exec(html))) {
    const label = cleanText(propertyMatch[2].match(/<div\b[^>]*class=['"][^'"]*\bproperty_label\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "");
    const value = cleanText(propertyMatch[2].match(/<(?:div|span)\b[^>]*class=['"][^'"]*\bproperty_value\b[^'"]*['"][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[1] || "");
    if (label && value) {
      const key = label.replace(/:\s*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
      properties[key] = value;
    }
  }

  const coverBlock = html.match(/<z-cover\b([^>]*)>([\s\S]*?)<\/z-cover>/i);
  const coverImage = coverBlock && coverBlock[2].match(/<img\b([^>]*)>/i);
  const coverSource = (coverImage && (attr(coverImage[1], "src") || attr(coverImage[1], "data-src"))) ||
    (typeof schema.image === "string" ? schema.image : "");
  let cover = "";
  try {
    if (coverSource) {
      const candidate = new URL(decode(coverSource), base);
      if (candidate.protocol === "https:") cover = candidate.href;
    }
  } catch {}

  const descriptionHtml =
    html.match(/<div\b[^>]*id=['"]bookDescriptionBox['"][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    (typeof schema.description === "string" ? schema.description : "") ||
    (typeof schema.review?.reviewBody === "string" ? schema.review.reviewBody : "");
  const description = cleanText(descriptionHtml)
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  const tagBlock = html.match(/<z-tags\b[^>]*>([\s\S]*?)<\/z-tags>/i);
  const tags = tagBlock
    ? [...tagBlock[1].matchAll(/<tag\b[^>]*>([\s\S]*?)<\/tag>/gi)].map(m => cleanText(m[1])).filter(Boolean)
    : [];

  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const downloadAnchor = anchors.find(m => /\baddDownloadedBook\b/i.test(attr(m[1], "class")));
  let download = "";
  if (downloadAnchor) {
    try {
      const candidate = new URL(attr(downloadAnchor[1], "href"), base);
      if (candidate.origin === new URL(base).origin && /^\/dl\/[A-Za-z0-9_-]+$/.test(candidate.pathname)) download = candidate.pathname;
    } catch {}
  }

  const fileInfo = properties.file || "";
  const format = (fileInfo.match(/\b(EPUB|PDF|MOBI|AZW3|FB2|DJVU|TXT|DOCX|RTF|HTML|CBZ|CBR)\b/i) || [])[1]?.toLowerCase() || "";
  const fileSize = (fileInfo.match(/\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/i) || [])[0] || "";
  const isbn10 = properties.isbn_10 || "";
  const isbn13 = properties.isbn_13 || schema.isbn || "";
  const categories = properties.categories || "";
  const language = properties.language || schema.inLanguage?.name || schema.inLanguage || "";
  const publisher = properties.publisher || schema.publisher?.name || "";
  const year = properties.year || schema.datePublished || "";
  const pages = properties.pages || schema.numberOfPages || "";
  const edition = properties.edition || "";

  return {
    title: title || schema.name || "",
    author: author || (Array.isArray(schema.author) ? schema.author.map(a => a.name).filter(Boolean).join(", ") : schema.author?.name || ""),
    language: String(language),
    cover, download, format, fileSize, path, properties,
    publisher: String(publisher),
    year: String(year),
    edition: String(edition),
    pages: String(pages),
    categories,
    isbn: String(isbn13 || isbn10 || ""),
    isbn10, isbn13: String(isbn13),
    tags,
    description
  };
}

function feed(title, self, entries, extra = "") {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">' +
    "<id>" + xml(self) + "</id><title>" + xml(title) + "</title><updated>" + new Date().toISOString() + "</updated>" +
    '<link rel="self" href="' + xml(self) + '" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>' +
    extra + entries.join("") + "</feed>";
}
function bookEntry(book, origin, key) {
  const detail = origin + "/opds/book?path=" + encodeURIComponent(book.path) + "&key=" + encodeURIComponent(key);
  const cover = book.cover
    ? '<link rel="http://opds-spec.org/image" href="' + xml(book.cover) + '" type="image/jpeg"/>' +
      '<link rel="http://opds-spec.org/image/thumbnail" href="' + xml(book.cover) + '" type="image/jpeg"/>'
    : "";
  return "<entry><title>" + xml(book.title) + "</title><id>" + xml(book.path) + "</id><updated>" + new Date().toISOString() + "</updated>" +
    cover + '<link rel="subsection" href="' + xml(detail) +
    '" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/></entry>';
}
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return proto + "://" + host;
}
function authorized(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "GET only");
    const origin = requestOrigin(req);
    const u = new URL(req.url, origin);
    const key = u.searchParams.get("key") || "";
    if (!authorized(key, process.env.OPDS_KEY)) return send(res, 401, "Unauthorized. Check the OPDS key.");
    const base = (process.env.ZLIB_BASE || DEFAULT_BASE).replace(/\/$/, "");
    const xmlHeaders = { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "no-store" };

    if (u.pathname === "/" || u.pathname === "/opds") {
      const extra = '<link rel="search" href="' + xml(origin + "/opds/search.xml?key=" + encodeURIComponent(key)) +
        '" type="application/opensearchdescription+xml" title="Search Z-Library"/>' +
        '<link rel="subsection" href="' + xml(origin + "/opds/popular?key=" + encodeURIComponent(key)) +
        '" type="application/atom+xml;profile=opds-catalog;kind=acquisition" title="Popular books"/>';
      res.writeHead(200, xmlHeaders);
      return res.end(feed("Z-Library", origin + "/opds?key=" + encodeURIComponent(key), [], extra));
    }

    if (u.pathname === "/opds/search.xml") {
      const body = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Z-Library</ShortName>' +
        '<Description>Search Z-Library</Description><Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="' +
        xml(origin) + '/opds/search?q={searchTerms}&amp;key=' + encodeURIComponent(key) + '"/></OpenSearchDescription>';
      return send(res, 200, body, "application/opensearchdescription+xml; charset=utf-8");
    }

    if (u.pathname === "/opds/search" || u.pathname === "/opds/popular") {
      const q = (u.searchParams.get("q") || "").trim();
      if (u.pathname.endsWith("/search") && (!q || q.length > 160)) return send(res, 400, "Search term must be 1–160 characters.");
      const target = u.pathname.endsWith("/popular")
        ? base + "/popular?languages%5B%5D=english"
        : base + "/s/" + encodeURIComponent(q) + "?languages%5B%5D=english";
      const response = await upstream(target, process.env);
      const html = await response.text();
      if (!response.ok) return send(res, 502, "Z-Library returned HTTP " + response.status + ".");
      const books = parseCards(html, base);
      const entries = books.map(book => bookEntry(book, origin, key));
      const self = origin + u.pathname + (q ? "?q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(key) : "?key=" + encodeURIComponent(key));
      res.writeHead(200, xmlHeaders);
      return res.end(feed(q ? "Search: " + q : "Popular books", self, entries));
    }

    if (u.pathname === "/opds/book") {
      const path = u.searchParams.get("path") || "";
      if (!allowedBookPath(path)) return send(res, 400, "Invalid book path.");
      const response = await upstream(base + path, process.env);
      const html = await response.text();
      if (!response.ok) return send(res, 502, "Z-Library returned HTTP " + response.status + ".");
      const book = parseDetails(html, path, base);
      if (!book.title) return send(res, 502, "Could not parse the book details page.");
      if (book.language && !/^english$/i.test(book.language)) return send(res, 404, "This catalogue currently lists English-language books only.");
      const acquisition = book.download
        ? '<link rel="http://opds-spec.org/acquisition" href="' + xml(origin + "/opds/download?path=" + encodeURIComponent(book.download) + "&key=" + encodeURIComponent(key)) +
          '" type="' + formatMime(book.format) + '" title="Download ' + xml(book.format ? book.format.toUpperCase() : "book") + '"/>'
        : "";
      const p = book.properties || {};
      const metadata = [
        book.publisher && "Publisher: " + book.publisher,
        book.year && "Year: " + book.year,
        book.edition && "Edition: " + book.edition,
        book.language && "Language: " + book.language,
        book.pages && "Pages: " + book.pages,
        book.categories && "Categories: " + book.categories,
        book.isbn10 && "ISBN-10: " + book.isbn10,
        book.isbn13 && "ISBN-13: " + book.isbn13,
        book.format && "Format: " + book.format.toUpperCase(),
        book.fileSize && "File size: " + book.fileSize
      ].filter(Boolean).join("\n");
      const summary = book.description || metadata;
      const imageLinks = book.cover
        ? '<link rel="http://opds-spec.org/image" href="' + xml(book.cover) + '" type="image/jpeg"/>' +
          '<link rel="http://opds-spec.org/image/thumbnail" href="' + xml(book.cover) + '" type="image/jpeg"/>'
        : "";
      const body = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><id>' + xml(base + path) + '</id><title>' + xml(book.title) +
        '</title><updated>' + new Date().toISOString() + '</updated><entry><title>' + xml(book.title) + '</title><id>' + xml(base + path) +
        '</id><updated>' + new Date().toISOString() + '</updated>' +
        (book.author ? '<author><name>' + xml(book.author) + '</name></author>' : "") +
        (book.publisher ? '<dc:publisher>' + xml(book.publisher) + '</dc:publisher>' : "") +
        (book.year ? '<dc:date>' + xml(book.year) + '</dc:date>' : "") +
        (book.language ? '<dc:language>' + xml(book.language) + '</dc:language>' : "") +
        (book.isbn ? '<dc:identifier>' + xml(book.isbn) + '</dc:identifier>' : "") +
        (book.categories ? '<dc:subject>' + xml(book.categories) + '</dc:subject>' : "") +
        (book.tags || []).map(tag => '<dc:subject>' + xml(tag) + '</dc:subject>').join("") +
        imageLinks + acquisition +
        (book.description ? '<dc:description>' + xml(book.description) + '</dc:description>' : "") +
        (summary ? '<summary type="text">' + xml(summary) + '</summary>' : "") +
        (book.description ? '<content type="text">' + xml(book.description) + '</content>' : "") +
        (metadata ? '<content type="text">' + xml(metadata) + '</content>' : "") +
        '</entry></feed>';
      res.writeHead(200, xmlHeaders);
      return res.end(body);
    }

    if (u.pathname === "/opds/download") {
      const path = u.searchParams.get("path") || "";
      if (!/^\/dl\/[A-Za-z0-9_-]+$/.test(path)) return send(res, 400, "Invalid download path.");
      const response = await upstream(base + path, process.env, { method: "GET" });
      if (!response.ok) return send(res, 502, "Download failed: HTTP " + response.status + ".");
      const headers = {
        "Content-Type": response.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "no-store"
      };
      const length = response.headers.get("content-length");
      const disposition = response.headers.get("content-disposition");
      if (length) headers["Content-Length"] = length;
      if (disposition) headers["Content-Disposition"] = disposition;
      res.writeHead(200, headers);
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
      return;
    }

    return send(res, 404, "Not found");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return send(res, 502, message);
  }
});

module.exports = { server };
