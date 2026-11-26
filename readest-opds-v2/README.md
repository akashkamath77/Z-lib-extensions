# Readest Z-Library OPDS v2

A separate OPDS 1.2 bridge for Readest. It does not replace the LNReader plugin or the earlier prototypes.

## Current scope

- OPDS root catalogue and OpenSearch endpoint.
- Popular English catalogue and first-page English search.
- Book metadata, cover, author, and direct download links when the Z-Library details page exposes a `/dl/` link.
- Streams downloads through the service; redirects to a file CDN are followed without forwarding Z-Library cookies.
- Handles the observed SHA-1 proof-of-work browser-check format. Unknown challenges and CAPTCHA pages are rejected.
- Optional private OPDS key and optional user-supplied Z-Library session cookie.

**Important:** the reference LNReader extension also implements a separate reader API flow. This OPDS bridge does not yet reconstruct an EPUB from that reader API. If a book page has no direct `/dl/` acquisition link, the catalogue can show its details but cannot download that edition. Z-Library can change its domains, markup, anti-bot checks, and download rules at any time. Use only books you are authorized to access.

## Deploy on Render

The Worker runs remotely; your computer does not need to stay on.

1. Open the [Render Dashboard](https://dashboard.render.com/).
2. Choose **New → Web Service** and connect GitHub if prompted.
3. Select `akashkamath77/Z-lib-extensions` and the `main` branch.
4. Set the **Root Directory** to `readest-opds-v2`.
5. Use the Wrangler configuration in this folder. If the setup asks for build settings, use:
   - Build command: `npm install`
   - Deploy command: `npx wrangler deploy`
6. Name the service `readest-zlib-opds` and choose the Free instance type.
7. Under **Environment Variables**, add:
   - Add `OPDS_KEY` as a **secret environment variable**. Use a long random password.
   - Set `ZLIB_BASE` to `https://z-lib.gd`.
   - Optionally add `ZLIB_COOKIE` as a **secret environment variable** only if your own Z-Library session is required. Never put cookies in GitHub.
8. Save and deploy. Your catalogue URL will be:
   `https://readest-zlib-opds-v2.YOUR-SUBDOMAIN.workers.dev/opds?key=YOUR_OPDS_KEY`

If you change the Worker name or use a custom domain, use the URL Cloudflare displays.

## Important Cloudflare limitation

Workers Free allows 10 ms of CPU time per request. The SHA-1 browser-check solver may exceed that limit if Z-Library presents a challenge. If the Worker reports error 1102, the options are to optimize/test the solver or use the Workers Paid plan with a higher CPU limit. We will test this before assuming the integration works. Network waiting time does not count toward CPU time.

## Use in Readest (Android)

In Readest: **Import → Online Library → Add catalog**, then paste the catalogue URL above.

## Endpoints

- `/opds?key=...` — catalogue root
- `/opds/popular?key=...` — popular English books
- `/opds/search.xml?key=...` — OpenSearch description
- `/opds/search?q=terms&key=...` — search
- `/opds/book?path=%2Fbook%2F...&key=...` — details and acquisition
- `/opds/download?path=%2Fdl%2F...&key=...` — streamed file

## Local run

Requires Node.js 20 or newer:

```sh
npm install
OPDS_KEY=replace-this ZLIB_BASE=https://z-lib.gd npm start
```

## Security

- Never commit HAR files, cookies, credentials, access tokens, or signed CDN URLs.
- The OPDS key is passed in the catalogue URL; treat that URL as a password.
- Cookies are sent only to the configured Z-Library origin. They are not forwarded to external download/CDN hosts.
- The browser-check solver handles only the observed SHA-1 computation challenge. It does not solve CAPTCHAs or bypass account restrictions.
