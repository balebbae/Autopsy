# install.autopsy.surf

Static site + install script served at <https://install.autopsy.surf>.

## Layout

```
web/
├── index.html        landing page (logo + curl one-liner + copy button)
├── install.sh        the actual install script (synced from repo root by `make web-pack`)
├── favicon.svg       Autopsy mark
├── _headers          Cloudflare Pages: serve install.sh as text/x-shellscript
├── _redirects        Cloudflare Pages: alias /install → /install.sh
└── functions/
    └── index.js      Pages Function: UA-sniff so `curl install.autopsy.surf` returns the script
```

## Deploy (Cloudflare Pages, direct upload)

1. `make web-pack` from the repo root → produces `dist/install-autopsy-surf.zip`.
2. Cloudflare dashboard → Pages → "Create a project" → "Direct Upload" → drop the zip.
3. Bind the custom domain `install.autopsy.surf` to the project (Pages → Custom Domains).

The canonical install command is:

```bash
curl -fsSL https://install.autopsy.surf/install.sh | bash
```

The bare URL (`https://install.autopsy.surf`) shows the landing page in browsers; the
`functions/index.js` Pages Function intercepts curl/wget user-agents and returns the
script body directly, so `curl install.autopsy.surf | bash` also works.

## Updating `install.sh`

The repo-root `install.sh` is the source of truth. After editing it, run
`make web-pack` to refresh `web/install.sh` and rebuild the zip; commit both.

## Source

<https://github.com/balebbae/Autopsy>
