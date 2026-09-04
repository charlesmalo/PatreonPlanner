import { CreatorSearch } from '../components/CreatorSearch';
import { TitleCardSequence } from '../components/TitleCardSequence';

interface LandingPageProps {
  signedIn: boolean;
}

export function LandingPage({ signedIn }: LandingPageProps) {
  return (
    <section>
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pitch. Plan. Play.</h1>
        <p className="mx-auto mt-3 max-w-prose text-slate-600 dark:text-slate-300">
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
