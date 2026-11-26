# Readest Z-Library OPDS

This repository now focuses exclusively on the experimental Readest OPDS bridge.

## Project

The Cloudflare Worker is in [readest-opds](./readest-opds). It exposes an OPDS catalogue intended for Readest on Android and can run independently of your computer.

## Deployment

See [readest-opds/README.md](./readest-opds/README.md) for setup and deployment instructions.

## Important

This is not an official Z-Library API. Z-Library may block cloud-hosted requests, require browser verification, change its website, or restrict downloads. Search, metadata, and file downloads must all be tested against the live service before this can be considered operational.

Never commit HAR captures, cookies, account credentials, signed URLs, or access tokens.
