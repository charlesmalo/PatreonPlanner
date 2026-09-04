# Brand assets

> Documentation lives here rather than beside the images. Everything in `apps/web/public/` is
> copied into the Docker image and served to anyone who asks, so a README placed there is a
> published document — these notes included.

The logo and mascot is a friendly robot holding three interlocking puzzle pieces, which is the
board's own idea: separate things that only mean something once they slot together in order.

## Where things go

| | |
| --- | --- |
| `apps/web/public/brand/` | **Ships.** Copied into the build verbatim and served at a stable URL. That is what a favicon, an `og:image` and anything quoted from outside the app all need. |
| `apps/web/src/assets/` | Images belonging to one screen. Imported by the component that uses them, so the bundler hashes the filename and a stale copy cannot be served from a cache. Nothing lives here yet. |

The rule is whether something outside the bundle needs to name the file. A favicon does; an
illustration inside one route does not. And every byte in `public/` is served to everyone, so
mockups and internal notes do not belong there.

## The one asset

`apps/web/public/brand/logo.png` — 512 × 512, RGBA, ~106 KB.

One file for both the favicon and the header mark, because it is one piece of artwork. It arrived
with a real alpha channel already: 64% of it is fully transparent, and the white inside the robot
is opaque, so nothing had to be keyed out by hand.

Colours sampled from the file rather than picked by eye:

| | |
| --- | --- |
| **`#FD5D46`** | The coral. Registered as `brand` in `tailwind.config.js`, so the wordmark cannot drift away from the artwork. |
| `#FEFEFE` | The fill inside the robot — near-white, and opaque. |

## The wordmark is text, not an image

The header pairs the mark with **Patreon**`Planner` — the first half inheriting the theme's
foreground so it works on light and dark alike, the second in `text-brand`.

Deliberately not a rendered wordmark. Text stays selectable, scales to any size, is read aloud as
the product's name rather than as pixels, and cannot fall out of step with the brand colour. The
logo generator's horizontal lockup was wrong twice over — it carried the wrong product name, and it
put pixels where text belongs.

## Known limitation: the mark is weak on light backgrounds

The artwork is a white fill with coral outlines. On the dark theme that reads beautifully — the
white body carries the silhouette. On the light theme the fill disappears into the background and
only the outlines remain, so at header size the robot fragments into disconnected coral shapes
rather than reading as a robot.

Made larger it is still fragmented; this is not a sizing problem. What would fix it is a variant
drawn for light backgrounds — darker outlines, or a solid coral silhouette — or setting the mark on
a badge so it always has its own background.

Recorded rather than worked around, because it is a drawing decision and not a code one.

## History worth not repeating

An earlier set from the logo generator was faulty and has been removed entirely: its horizontal
lockup read **“PuzzleBot”**, and four of its files were JPEGs carrying a `.png` extension. Keeping
wrong artwork around is how it ends up used by mistake.
