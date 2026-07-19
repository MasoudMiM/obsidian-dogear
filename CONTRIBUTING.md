# Contributing

Thanks for taking an interest. Bug reports, feature requests and pull
requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/MasoudMiM/obsidian-dogear/issues) and
include your Obsidian version, your operating system, and what you expected to
happen. If a book note is involved, the frontmatter of that note is usually
the fastest way to reproduce the problem — remove anything private first.

## Suggesting a feature

Check [ROADMAP.md](ROADMAP.md) first: some things are deliberately out of
scope, and the reasoning is written down there. If your idea is on the "not
planned" list and you disagree, say so — the reasoning may be wrong.

## Working on the code

```bash
npm install
npm test          # the full suite
npm run dev       # watch build
npm run build     # production build
npm run lint      # Obsidian's plugin lint rules
```

To try your build in a vault, copy `main.js`, `manifest.json` and `styles.css`
into `YourVault/.obsidian/plugins/dogear/`.

### How the code is arranged

- `src/` holds the logic layer. It imports neither the DOM nor the Obsidian
  API, which is what makes it testable directly.
- `src/ui/` holds everything that touches the interface.
- `src/providers/` holds one adapter per metadata source.
- `test/` mirrors that structure.

Please keep that separation. If a function needs `document` or `obsidian`, it
belongs in `src/ui/`; if it can be expressed without them, it belongs in the
logic layer where it can be tested.

### Before opening a pull request

- `npm test` passes.
- `npm run lint` is clean. These are the rules Obsidian's own plugin scorecard
  runs, so anything they flag would otherwise be found after release.
- New behaviour has a test. The suite is large because bugs found by hand
  became permanent tests, and that has repeatedly paid off.
- User-visible text uses sentence case and avoids jargon.

## Data sources

Dogear talks to free, public catalogues that owe us nothing. If you add or
change a request path, respect the documented rate limits, keep requests
client-side, and never ship an API key. When a limit is unclear, size the
budget by how bad the penalty is rather than how fast the service will let you
go.
