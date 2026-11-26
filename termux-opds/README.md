# Readest Z-Library OPDS bridge for Android (Termux)

This is the local-device alternative to the Cloudflare Worker. It runs on the Android phone in Termux, so the PC can stay off. Readest connects to the OPDS feed on the same phone.

## Why this backend

The bridge calls the `heartleo/zlib` CLI instead of scraping Z-Library HTML itself. That CLI supports the unofficial mobile-app/EAPI route; the related Bookplate project documents that it uses EAPI to handle the DiamWall proof-of-work that blocks ordinary cloud HTTP clients. This avoids trying to solve a CPU-intensive browser check inside a free Cloudflare Worker.

Upstream: https://github.com/heartleo/zlib  
Related OPDS implementation: https://github.com/bacnh85/bookplate  
This bridge is a separate, minimal OPDS adapter; it does not copy Bookplate's application.

## Install on Android

1. Install **Termux from F-Droid or its official GitHub releases**. Do not use the obsolete Play Store build.
2. Open Termux and run:

```sh
pkg update -y
pkg upgrade -y
pkg install -y python golang
python -m pip install --upgrade pip
python -m pip install fastapi uvicorn
go install github.com/heartleo/zlib/cmd/zlib@latest
echo 'export PATH="$HOME/go/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
zlib version
```

If the Go package in Termux is older than the version required by the upstream repository, update Go before continuing.

## Sign in to Z-Library

Run the EAPI domain check and select a domain reported as healthy:

```sh
zlib doctor --eapi
```

Then sign in (the password is entered at the prompt; do not put it in a command or this repository):

```sh
zlib login --eapi --domain https://YOUR-HEALTHY-MIRROR
```

The CLI stores its session locally under your Termux home directory. Do not copy that session file into GitHub or share it.

## Start the OPDS service

From this folder:

```sh
python -m uvicorn server:app --host 127.0.0.1 --port 8765
```

Keep the Termux session running while using Readest. For long sessions, run `termux-wake-lock` first and disable battery optimization for Termux.

Open this URL in Readest → OPDS catalog:

```
http://127.0.0.1:8765/opds
```

Search is exposed through OPDS OpenSearch. The first version supports keyword search, pagination, format filtering, metadata and acquisition downloads.

## Optional local token

By default, the service binds only to `127.0.0.1`, so it is not exposed to your Wi-Fi network. You can add a token anyway:

```sh
export OPDS_TOKEN='use-a-long-random-value'
```

Then use:

```
http://127.0.0.1:8765/opds?token=YOUR_TOKEN
```

## Current test status

- The OPDS adapter is written around the CLI command and JSON shape used by Bookplate's maintained Z-Library adapter.
- It has not yet been run on your Android device or tested against your Readest build.
- The upstream CLI's EAPI login, mirror availability, and Z-Library download quota still apply.
- Keep Termux running; this is not a cloud service and it stops when Android kills the process.
- Z-Library may change its unofficial API at any time.

## Legal and security notes

Use only material you are authorized to access and comply with applicable copyright law and Z-Library's terms. Never commit account credentials, cookies, session files, downloaded books or signed links.
