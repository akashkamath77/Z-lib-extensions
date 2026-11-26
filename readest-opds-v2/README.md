# Readest Z-Library OPDS v2

A separate Node.js OPDS 1.2 bridge for Readest. It does not replace the LNReader plugin or the earlier \`readest-opds\` prototype.

## Current scope

- OPDS root catalogue and OpenSearch endpoint.
- Popular English catalogue and first-page English search.
- Book metadata, cover, author, and direct download links when the Z-Library details page exposes a \`/dl/\` link.
- Streams downloads through the service; redirects to a file CDN are followed without forwarding Z-Library cookies.
- Handles the specific SHA-1 proof-of-work browser-check format documented in the reference LNReader extension. Unknown challenges and CAPTCHA pages are rejected.
- Optional private OPDS key and optional user-supplied Z-Library session cookie.

**Important:** the reference extension also implements a separate reader API flow. This OPDS bridge does not yet reconstruct an EPUB from that reader API. If a book page has no direct \`/dl/\` acquisition link, the catalogue can show its details but cannot download that edition. Z-Library can change its domains, markup, anti-bot checks, and download rules at any time. Use only books you are authorized to access.

## Deploy on Render (free test deployment)

The service runs remotely; your computer does not need to stay on. Render's free web service sleeps after 15 minutes without traffic and can take about a minute to wake up again.

1. In Render, choose **New → Web Service** and connect this GitHub repository.
2. Set **Root Directory** to \`readest-opds-v2\`.
3. Set **Build Command** to \`npm install\`.
4. Set **Start Command** to \`npm start\`.
5. Select the **Free** instance.
6. Add environment variables:
   - \`OPDS_KEY\`: a long random password (required).
   - \`ZLIB_BASE\`: \`https://z-lib.do\`.
   - \`ZLIB_COOKIE\`: optional; only if your own session is needed. Keep it in Render environment variables, never in GitHub.
7. Deploy. Your catalogue root will be:
   \`https://YOUR-SERVICE.onrender.com/opds?key=YOUR_OPDS_KEY\`

In Readest on Android: **Import → Online Library → Add catalog**, then paste the catalogue URL. Readest supports OPDS catalogues and downloads acquired books into its library.

## Endpoints

- \`/opds?key=...\` — catalogue root
- \`/opds/popular?key=...\` — popular English books
- \`/opds/search.xml?key=...\` — OpenSearch description
- \`/opds/search?q=terms&key=...\` — search
- \`/opds/book?path=%2Fbook%2F...&key=...\` — details and acquisition
- \`/opds/download?path=%2Fdl%2F...&key=...\` — streamed file

## Local run

Requires Node.js 20 or newer:

\`\`\`sh
npm install
OPDS_KEY=replace-this ZLIB_BASE=https://z-lib.do npm start
\`\`\`

## Security

- Never commit HAR files, cookies, credentials, access tokens, or signed CDN URLs.
- The OPDS key is passed in the catalogue URL; treat that URL as a password.
- Cookies are sent only to the configured Z-Library origin. They are not forwarded to external download/CDN hosts.
- The browser-check solver handles only the observed SHA-1 computation challenge. It does not solve CAPTCHAs or bypass account restrictions.
