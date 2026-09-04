import { CreatorSearch } from '../components/CreatorSearch';
import { TitleCardSequence } from '../components/TitleCardSequence';

interface LandingPageProps {
  signedIn: boolean;
}

export function LandingPage({ signedIn }: LandingPageProps) {
  return (
    <section>
      <div className="flex flex-col items-center text-center">
        {/*
          Decorative, and large on purpose. The mascot is drawn as a white fill with coral
          outlines, which at header size leaves the silhouette to fragment against a light
          background — see docs/brand/README.md. At this size the outlines carry it, so the hero is
          where the artwork is actually shown rather than merely referenced.

          alt="" because the heading beneath already says everything the picture does; naming it
          would have a screen reader announce the product twice before the slogan.
        */}
        <img
          src="/brand/logo.png"
          alt=""
          aria-hidden="true"
          className="h-28 w-auto sm:h-36"
          // Explicit so the browser reserves the box before the bytes land, rather than
          // reflowing the slogan downward once they do.
          width={512}
          height={512}
        />

        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          {/* The last word in the brand colour, echoing the wordmark in the header — and it is
              the word the whole board is pointed at. */}
          Pitch. Plan. <span className="text-brand">Play.</span>
        </h1>

        <p className="mt-3 max-w-prose text-slate-600 dark:text-slate-300">
          A request board for Patreon creators. Patrons suggest what to cover next and upvote each
          other&apos;s picks, you run it as a queue rather than a scroll of comments — and who may
          suggest and vote is decided by your own Patreon tiers.
        </p>
      </div>

      {/* The slogan again, as the thing it describes. Decorative movement over real text: the three
          stages read in order whether or not anything animates. */}
      <div className="mt-8">
        <TitleCardSequence />
      </div>

      <div className="mt-10">
        <CreatorSearch signedIn={signedIn} />
      </div>
    </section>
  );
}
