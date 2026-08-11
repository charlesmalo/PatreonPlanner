export function LandingPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">
        Suggest what your creator watches next
      </h1>
      <p className="mt-3 max-w-prose text-slate-600 dark:text-slate-300">
        PatreonPlanner gives a creator&apos;s patrons one place to suggest films and shows, upvote
        each other&apos;s picks, and see what is coming up — with who can suggest and vote decided
        by the creator&apos;s own Patreon tiers.
      </p>
      <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
        Open a creator&apos;s board at <code className="font-mono">/c/their-slug</code>.
      </p>
    </section>
  );
}
