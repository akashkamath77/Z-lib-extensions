import asyncio
import html
import mimetypes
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

APP_TITLE = "Z-Library OPDS (Termux)"
MAX_RESULTS = 50
FORMATS = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "mobi": "application/x-mobipocket-ebook",
    "azw": "application/vnd.amazon.ebook",
    "azw3": "application/vnd.amazon.ebook",
    "fb2": "application/x-fictionbook+xml",
    "djvu": "image/vnd.djvu",
    "cbz": "application/vnd.comicbook+zip",
}
ID_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
BOOK_CACHE: dict[str, dict] = {}

app = FastAPI(title=APP_TITLE)


def x(value) -> str:
    return html.escape(str(value or ""), quote=True)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def check_token(request: Request) -> None:
    expected = os.getenv("OPDS_TOKEN", "")
    if expected and request.query_params.get("token", "") != expected:
        raise HTTPException(401, "Invalid OPDS token")


async def cli(*args: str, timeout: int = 120) -> str:
    if shutil.which("zlib") is None:
        raise HTTPException(503, "zlib CLI is missing. Install and sign in first; see README.")
    try:
        proc = await asyncio.create_subprocess_exec(
            "zlib", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(504, "Z-Library request timed out")
    out = stdout.decode("utf-8", errors="replace")
    err = stderr.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        message = (err or out or "zlib command failed").strip()
        raise HTTPException(502, message[-1200:])
    return out


def book_id(book: dict) -> str:
    value = str(book.get("id") or "")
    if not ID_RE.fullmatch(value):
        return ""
    return value


def author_text(book: dict) -> str:
    authors = book.get("authors") or book.get("author") or ""
    if isinstance(authors, list):
        return ", ".join(str(a) for a in authors if a)
    return str(authors)


def media_type(book: dict) -> str:
    ext = str(book.get("extension") or "").lower().lstrip(".")
    return FORMATS.get(ext, mimetypes.guess_type("book." + ext)[0] or "application/octet-stream")


def make_entry(book: dict, base: str, token: str = "") -> str:
    bid = book_id(book)
    if not bid:
        return ""
    BOOK_CACHE[bid] = book
    if len(BOOK_CACHE) > 1000:
        BOOK_CACHE.pop(next(iter(BOOK_CACHE)))
    suffix = ("&token=" + quote(token)) if token else ""
    detail = f"{base}/opds/book?id={quote(bid, safe='')}{suffix}"
    download = f"{base}/opds/download?id={quote(bid, safe='')}{suffix}"
    title = book.get("name") or book.get("title") or "Untitled"
    author = author_text(book)
    ext = str(book.get("extension") or "").upper()
    description = book.get("description") or ""
    size = book.get("size") or ""
    language = book.get("language") or ""
    year = book.get("year") or ""
    cover = str(book.get("cover") or "")
    cover_link = (
        f'<link rel="http://opds-spec.org/image" href="{x(cover)}" type="image/jpeg"/>'
        if cover.startswith("https://") else ""
    )
    return f"""
    <entry>
      <id>urn:zlibrary:{x(bid)}</id>
      <title>{x(title)}</title>
      <updated>{now()}</updated>
      {f'<author><name>{x(author)}</name></author>' if author else ''}
      <summary type="text">{x(description or " · ".join(v for v in [ext, str(size), str(language), str(year)] if v))}</summary>
      {cover_link}
      <link rel="subsection" href="{x(detail)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
      <link rel="http://opds-spec.org/acquisition" href="{x(download)}" type="{x(media_type(book))}" title="Download {x(ext or 'book')}"/>
    </entry>"""


def feed(title: str, self_url: str, entries: list[str], extra: str = "") -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>{x(self_url)}</id>
  <title>{x(title)}</title>
  <updated>{now()}</updated>
  <link rel="self" href="{x(self_url)}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog"/>
  {extra}
  {''.join(entries)}
</feed>'''


def xml_response(body: str) -> Response:
    return Response(
        content=body,
        media_type="application/atom+xml; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/")
@app.get("/opds")
async def root(request: Request):
    check_token(request)
    base = str(request.base_url).rstrip("/")
    token = request.query_params.get("token", "")
    token_suffix = ("&token=" + quote(token)) if token else ""
    search = f'<link rel="search" href="{base}/opds/search.xml?token={quote(token)}" type="application/opensearchdescription+xml" title="Search Z-Library"/>'
    return xml_response(feed("Z-Library", base + "/opds" + (("?token=" + quote(token)) if token else ""), [], search))


@app.get("/opds/search.xml")
async def search_description(request: Request):
    check_token(request)
    base = str(request.base_url).rstrip("/")
    token = request.query_params.get("token", "")
    suffix = ("&amp;token=" + quote(token)) if token else ""
    body = f'''<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Z-Library</ShortName>
  <Description>Search Z-Library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="{x(base)}/opds/search?q={{searchTerms}}{suffix}"/>
</OpenSearchDescription>'''
    return Response(body, media_type="application/opensearchdescription+xml; charset=utf-8")


@app.get("/opds/search")
async def search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=160),
    page: int = Query(1, ge=1, le=1000),
    ext: str = Query("", max_length=8),
):
    check_token(request)
    query = " ".join(q.split())
    if ext and ext.lower() not in FORMATS:
        raise HTTPException(400, "Unsupported format filter")
    args = ["search", query, "--json", "-n", str(MAX_RESULTS), "-p", str(page)]
    if ext:
        args += ["--ext", ext.lower()]
    output = await cli(*args)
    try:
        parsed = __import__("json").loads(output)
        books = parsed.get("books", []) if isinstance(parsed, dict) else []
    except Exception:
        raise HTTPException(502, "zlib CLI returned invalid JSON")
    base = str(request.base_url).rstrip("/")
    token = request.query_params.get("token", "")
    entries = [make_entry(book, base, token) for book in books if isinstance(book, dict)]
    entries = [entry for entry in entries if entry]
    page_now = int(parsed.get("page") or page)
    total_pages = int(parsed.get("total_pages") or page_now)
    query_suffix = f"q={quote(query)}"
    if ext:
        query_suffix += f"&ext={quote(ext.lower())}"
    token_suffix = ("&token=" + quote(token)) if token else ""
    links = []
    if page_now < total_pages:
        links.append(f'<link rel="next" href="{base}/opds/search?{query_suffix}&amp;page={page_now + 1}{token_suffix}" type="application/atom+xml;profile=opds-catalog"/>')
    if page_now > 1:
        links.append(f'<link rel="previous" href="{base}/opds/search?{query_suffix}&amp;page={page_now - 1}{token_suffix}" type="application/atom+xml;profile=opds-catalog"/>')
    self_url = f"{base}/opds/search?{query_suffix}&amp;page={page_now}{token_suffix}"
    return xml_response(feed(f"Z-Library: {query}", self_url, entries, "".join(links)))


@app.get("/opds/book")
async def details(request: Request, id: str = Query(...)):
    check_token(request)
    if not ID_RE.fullmatch(id):
        raise HTTPException(400, "Invalid book reference")
    book = BOOK_CACHE.get(id)
    if not book:
        raise HTTPException(404, "Search for the book again; its cached details have expired.")
    base = str(request.base_url).rstrip("/")
    token = request.query_params.get("token", "")
    entry = make_entry(book, base, token)
    self_url = f"{base}/opds/book?id={quote(id, safe='')}"
    if token:
        self_url += "&token=" + quote(token)
    return xml_response(feed(book.get("name") or book.get("title") or "Book details", self_url, [entry]))


@app.get("/opds/download")
async def download(request: Request, id: str = Query(...)):
    check_token(request)
    if not ID_RE.fullmatch(id):
        raise HTTPException(400, "Invalid book reference")
    temp_dir = Path(tempfile.mkdtemp(prefix="readest-zlib-"))
    try:
        await cli("download", id, "--dir", str(temp_dir), timeout=600)
        files = [p for p in temp_dir.iterdir() if p.is_file()]
        if not files:
            raise HTTPException(502, "zlib completed without producing a book file")
        path = max(files, key=lambda p: p.stat().st_mtime)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return FileResponse(
            path,
            media_type=content_type,
            filename=path.name,
            background=BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True),
        )
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


@app.get("/health")
async def health():
    return {"ok": True, "zlib_installed": shutil.which("zlib") is not None}
