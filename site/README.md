# autopsy.surf

Marketing landing page for the root domain.

## Layout

```
site/
├── index.html      hero + problem + closed loop + features + install CTA + footer
├── favicon.svg     Autopsy mark with primary-blue pulse
└── README.md       this file
```

Static, self-contained, single HTML file. No build step. Drop the directory contents into any static host.

## Deploy (Cloudflare Pages, direct upload)

1. `make site-pack` from the repo root → produces `dist/autopsy-surf.zip`.
2. Cloudflare dashboard → Pages → "Create a project" → "Direct Upload" → drop the zip.
3. Pages → Custom Domains → bind `autopsy.surf` (and `www.autopsy.surf` if desired).

The install subdomain (`install.autopsy.surf`) is a separate Pages project — see `web/`.

## Source

<https://github.com/balebbae/Autopsy>
