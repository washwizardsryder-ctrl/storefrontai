# Storefront AI — website

Local AI-visibility (AEO) landing page + free instant-scan function.

## Deploy (Netlify + Git)
1. This repo's root is the web root — `index.html` is here.
2. In Netlify: link this repo. Build command: none. Publish directory: `.`
3. Netlify auto-bundles `netlify/functions/scan.js` (the free scan endpoint).
4. Add env var `ANTHROPIC_API_KEY` in Netlify (never commit it).
5. Set a monthly spend cap in the Anthropic Console before sharing the link.

Structure:
- `index.html` / `success.html` — the site
- `netlify.toml` — routes `/api/scan` to the function
- `netlify/functions/scan.js` — the live scan (needs the env var)
