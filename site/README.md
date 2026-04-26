# autopsy.surf

Marketing landing page for the root domain.

## Layout

```
site/
├── index.html      hero + problem + closed loop + 8 feature cards + install CTA + footer
├── favicon.svg     Autopsy mark with primary-blue pulse
├── og.png          1200×630 social card (Open Graph / Twitter)
└── README.md       this file
```

Static, self-contained, single HTML file. No build step. Drop the directory contents into any static host.

The hero and the install + footer block are each `min-height: calc(100vh - 64px)` so the page lands cleanly on a centered hero on first paint and a centered install CTA when scrolled to the bottom.

## Regenerating `og.png`

`og.png` is rendered from a dedicated 1200×630 template in `scripts/og/template.html` (kept out of the deploy bundle so the marketing page itself can stay viewport-driven).

```sh
make site-og     # → site/og.png
make site-pack   # → dist/autopsy-surf.zip
```

## Deploy (Cloudflare Pages, direct upload)

1. `make site-pack` from the repo root → produces `dist/autopsy-surf.zip`.
2. Cloudflare dashboard → Pages → "Create a project" → "Direct Upload" → drop the zip.
3. Pages → Custom Domains → bind `autopsy.surf` (and `www.autopsy.surf` if desired).

The install subdomain (`install.autopsy.surf`) is a separate Pages project — see `web/`.

## Source

<https://github.com/balebbae/Autopsy>
