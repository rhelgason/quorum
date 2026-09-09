# docs/img — figures and placeholders

Two kinds of file live here.

## Generated figures — do not edit by hand

`northwind-*.svg` are written by `npm run northwind`, from the same run that
prints the report. That is deliberate: a number in the README and a number in a
chart cannot drift apart if both come from one execution. Editing one by hand
breaks that, and the next run overwrites it anyway.

Each has a `-dark` variant, selected in the README with `<picture>` — dark is a
palette **stepped for the dark surface**, not an inverted light one.
`prefers-color-scheme` inside an SVG loaded through `<img>` does not apply,
which is why there are two files rather than one.

Colours come from a validated palette, checked for colour-vision separation and
surface contrast in both modes before anything was drawn. The charts carry
direct labels rather than a hover layer, because GitHub strips scripts from
embedded SVG.

| File | Figure |
| --- | --- |
| `northwind-pipeline.svg` | Four channels → 428 submissions → 102 clusters → 59 issues → top 10 |
| `northwind-ranked.svg` | Top ten issues by score |
| `northwind-weighting.svg` | Rank with every account equal vs weighted by revenue |
| `northwind-regression.svg` | Weekly crash reports against the release that caused them |

## Placeholders — replace these

`placeholder-*.svg` are stand-ins for screenshots and GIFs that need a human
with a browser. **Replace the file, keep the name** and the README needs no
edit — or change the `src` if you would rather use a different extension.

| File | Size | What it wants |
| --- | --- | --- |
| `placeholder-hero.svg` | 1200×620 | **GIF.** Open the demo, press <kbd>⌘⇧K</kbd>, type a complaint, send it, cut to the backlog with the new row highlighted. ~10s, looped. |
| `placeholder-backlog.svg` | 1200×760 | **Screenshot.** `localhost:4173/backlog` with one row expanded, showing score components and verbatim quotes. |
| `placeholder-picker.svg` | 1200×620 | **GIF.** Click *Point at it*, hover a few elements so the highlight follows, click one, land back in the composer. ~6s, looped. |
| `placeholder-nub.svg` | 900×620 | **Screenshot.** The nub open on the demo page, close crop — the panel against the host page's own design. Optionally three, one per preset. |

All four come from `npm run app`. A couple of notes for whoever takes them:

- **Retina, then downscale.** Capture at 2× and export at the listed size.
- **Keep the host page in frame** for the nub and picker shots. The point of
  shadow DOM is that the widget does not inherit or leak styling, and that only
  reads if Northwind's own design is visible beside it.
- **The backlog shot wants a row expanded.** Collapsed, it is a list of
  sentences; expanded, it shows the thing the product is actually claiming —
  that every row decomposes into numbers and quotes you can check.
