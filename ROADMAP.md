# Roadmap

What is planned next, and what is deliberately out of scope. Suggestions are
welcome as [issues](https://github.com/MasoudMiM/obsidian-dogear/issues).

## Next

- **CSV export.** Your library is already plain Markdown you can take
  anywhere, so this is about interoperating with other trackers rather than
  escaping this one — but it should exist.
- **A metadata cache that survives a restart.** Lookups are cached in memory
  today, so restarting Obsidian makes the plugin ask for books it already
  knew. This is the largest remaining reduction in requests to the free
  catalogues Dogear depends on.
- **Enrich a book added by hand.** A book entered manually should be able to
  pull in covers and page counts later, once you know its ISBN.
- **Search on demand.** Search-as-you-type is generous to the reader and
  wasteful against a rate-limited public catalogue. An explicit search option
  would suit people on slow or metered connections.

- **The declarative settings API.** Obsidian 1.13 added
  `getSettingDefinitions()`, which makes a plugin's settings searchable from
  the main settings search. Adopting it would raise the minimum version, so it
  is worth doing once 1.13 is widespread rather than now.

## Later

- **More metadata sources.** The provider chain takes new sources cheaply.
  Hardcover and ISBNdb are the obvious candidates, though both require a key.
- **StoryGraph import.** The other major migration path out of Goodreads.
- **Bases view templates** for shelves and statistics, so people who prefer
  building their own views have a starting point.
- **A year-end summary.** The one genuinely delightful thing reading trackers
  do, and the feature people most often say they stay for.
- **Barcode scanning on mobile**, for adding physical shelves in bulk.
- **Reading goals and streaks**, strictly opt-in and off by default. Some
  readers find them motivating; others specifically want a tracker that does
  not keep score.

## Not planned

These are omissions rather than gaps, and each is deliberate.

- **Ownership, lending and shelf locations.** Dogear tracks reading, not
  possessions. Cataloguing what you own is a different application.
- **Social features** — friends, feeds, community reviews, book clubs. A vault
  is a private, single-user space, and pretending otherwise would be a poor
  imitation of a service that already exists.
- **Recommendations.** These need a corpus of other readers' data, which a
  local plugin does not have and should not want.
- **Content warnings.** Valuable, but only as crowd-sourced data. Maintained
  by hand in a single vault they would be a chore that quickly falls stale.
- **Self-reported pace and mood.** Pace is computed from what you actually
  logged rather than guessed at; mood is a tag if you want one.
- **Kindle sync.** Not possible from a plugin. Use one of the existing
  highlight-import plugins alongside Dogear.
