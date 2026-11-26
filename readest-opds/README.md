# Readest OPDS bridge (experimental)

A Cloudflare Worker that exposes a small OPDS 1.2 catalogue for the Z-Library website structure captured in the project's test HAR. It is separate from the LNReader extension.

## Important limitations

- This is an experimental adapter, not an official Z-Library API.
- The site may block cloud-hosted requests with browser verification, change its HTML, require a current session cookie, or restrict downloads.
- Search currently parses the first HTML results page only. Pagination has not been verified.
- EPUB download responses are streamed through the Worker; large-file and Readest compatibility must be tested.
- Use only content you are authorized to access. Do not commit HAR files, cookies, account credentials, signed URLs, or tokens.

## Deploy free on Cloudflare Workers

1. Create a free Cloudflare account and a Worker.
2. Deploy `worker.js` as the Worker entry point (or connect this repository using Cloudflare Workers Builds).
3. In Worker **Settings → Variables and Secrets**, add:
   - Secret `OPDS_KEY`: a long random password. This protects your catalogue URL.
   - Optional secret `ZLIB_COOKIE`: your own current Z-Library session cookie, only if the site requires login for the pages you access. Keep it in Cloudflare Secrets; never put it in GitHub or share it in chat.
   - Optional variable `ZLIB_BASE`: `https://z-lib.gd` (change only if your accessible site domain differs).
4. Deploy/redeploy after adding variables.
5. Open `https://YOUR-WORKER.workers.dev/opds?key=YOUR_OPDS_KEY`.
6. In Readest, add that URL as an OPDS catalogue.

## Endpoints

- `/opds?key=...` — catalogue root
- `/opds/search?q=search%20terms&key=...` — search
- `/opds/book?path=%2Fbook%2F...&key=...` — metadata and acquisition link
- `/opds/download?path=%2Fdl%2F...&key=...` — streamed download

## Current status

Initial implementation only. Do not treat it as working until the deployed Worker passes live search, metadata, and download tests from Readest.
