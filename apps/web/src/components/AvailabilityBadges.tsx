import type { Availability, AvailabilityOffer } from '../api/types';
import { isSafeHttpUrl } from './RecommendationCard';

// Built here rather than stored, so the image size can change without a migration.
const LOGO_BASE = 'https://image.tmdb.org/t/p/w45';

// Cheapest way to watch first. A patron who already subscribes should not read past a rental
// offer to discover they can just stream it.
const KIND_ORDER: Record<string, number> = { FLATRATE: 0, FREE: 1, ADS: 2, RENT: 3, BUY: 4 };

const KIND_LABELS: Record<string, string> = {
  FLATRATE: 'Stream',
  FREE: 'Free',
  ADS: 'Free with ads',
  RENT: 'Rent',
  BUY: 'Buy',
};

interface AvailabilityBadgesProps {
  availability: Availability | null;
  title: string;
}

export function AvailabilityBadges({ availability, title }: AvailabilityBadgesProps) {
  // An empty row means "we asked and there is nothing here" — a real answer, but not one worth a
  // heading and an attribution on every unavailable card.
  if (!availability || availability.offers.length === 0) return null;

  const badges = collapseByProvider(availability.offers);

  const strip = (
    <ul className="flex flex-wrap items-center gap-2">
      {badges.map((offer) => (
        <li
          key={offer.providerId}
          className="flex items-center gap-1.5 rounded border border-slate-200 px-1.5 py-0.5 dark:border-slate-700"
        >
          {offer.logoPath ? (
            <img
              src={`${LOGO_BASE}${offer.logoPath}`}
              width={18}
              height={18}
              loading="lazy"
              alt={offer.providerName}
              className="h-[18px] w-[18px] rounded-sm object-cover"
            />
          ) : null}
          {/* Text, never markup: the provider name comes from a third party. */}
          <span data-testid="provider-name" className="text-xs">
            {offer.providerName}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {KIND_LABELS[offer.kind] ?? offer.kind}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="mt-2">
      <h4 className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Where to watch ({availability.region})
      </h4>
      <div className="mt-1">
        {/* The same guard the cards use. The base URL is env-configurable, so the upstream is
            not a trust boundary, and React only warns on a javascript: href — it does not block
            it. */}
        {availability.link && isSafeHttpUrl(availability.link) ? (
          <a
            href={availability.link}
            target="_blank"
            // The URL comes from a third party, so the opened page must not get a handle on this
            // one.
            rel="noopener noreferrer"
            aria-label={`Where to watch “${title}”`}
            className="inline-block rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            {strip}
          </a>
        ) : (
          // No link rather than a dead one: the data gives providers, not always a destination.
          strip
        )}
      </div>
      {/* TMDB sources this from JustWatch and its terms require the attribution wherever it shows. */}
      <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
        Availability data by JustWatch
      </p>
    </div>
  );
}

/**
 * One badge per provider. A title available to rent *and* to buy from the same shop is one place
 * to watch it, and listing it twice reads as two.
 */
function collapseByProvider(offers: AvailabilityOffer[]): AvailabilityOffer[] {
  const best = new Map<number, AvailabilityOffer>();
  for (const offer of offers) {
    const existing = best.get(offer.providerId);
    if (!existing || rank(offer) < rank(existing)) best.set(offer.providerId, offer);
  }
  return [...best.values()].sort(
    (a, b) => rank(a) - rank(b) || a.displayPriority - b.displayPriority,
  );
}

function rank(offer: AvailabilityOffer): number {
  return KIND_ORDER[offer.kind] ?? 99;
}
