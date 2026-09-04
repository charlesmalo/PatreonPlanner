# Brand assets

> Documentation lives here rather than beside the images. Everything in `apps/web/public/` is
> copied into the Docker image and served to anyone who asks, so a README placed there is a
> published document — these notes included.

The logo and mascot: a friendly robot holding three interlocking puzzle pieces, which is the
board's own idea — separate things that only mean something once they slot together in order.

## Where things go

|                          |                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/public/brand/` | **Ships.** Copied into the build verbatim and served at a stable URL — `/brand/mascot.png`. That is what a favicon, an `og:image` and anything quoted from outside the app all need. |
| `apps/web/src/assets/`   | Images belonging to one screen. Imported by the component that uses them, so the bundler hashes the filename and a stale copy cannot be served from a cache. Nothing lives here yet. |
| `docs/brand/source/`     | **Does not ship.** Everything the logo generator produced — mockups, alternates, the files below that the app cannot use. Kept as source material.                                   |

The rule is whether something outside the bundle needs to name the file. A favicon does; an
illustration inside one route does not. The rule for `public/` in particular is that every byte
here is copied into the Docker image and served to everyone, so marketing mockups do not belong.

## What is here

|               |                 |                                                                                                                                           |
| ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `favicon.png` | 512 × 512, RGBA | The simplified mark — the robot's head and body, no outlines to lose. Linked from `index.html` as both the icon and the Apple touch icon. |
| `mascot.png`  | 675 × 897, RGBA | The full mascot, no wordmark. Sits in the header beside the product name.                                                                 |

Both have a real alpha channel, so they sit on the light and dark themes without a white tile
behind them. The mascot's body is filled white rather than left transparent, which is what keeps it
readable on a dark background instead of collapsing to outlines.

## What is deliberately not here

**The horizontal lockup, because its wordmark reads “PuzzleBot”.** The generator was working from a
different name, and the artwork is right while the word beside it is not. It is kept at
`docs/brand/source/wordmark-horizontal-transparent.png` so it is not lost, and it is not used
anywhere in the interface.

Until a lockup exists that says PatreonPlanner, the header pairs `mascot.png` with the product name
as ordinary text — which is also the more accessible arrangement, since the name is then real text
rather than pixels.

**There is no dark-theme variant.** The generator produced only the light set — the filenames say
so. The two assets above happen to work on both because of the white fill, but a mark designed for
dark backgrounds would be better than one that survives them.

**Four of the generator's files are JPEGs with a `.png` extension.** Renamed to `.jpg` on the way
into `docs/brand/source/`. Browsers sniff the content and would have rendered them anyway, but a
filename that lies about its format is a trap for the next person.
