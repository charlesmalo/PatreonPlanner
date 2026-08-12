import { render, screen } from '@testing-library/react';
import { AvailabilityBadges } from './AvailabilityBadges';
import type { Availability } from '../api/types';

function availability(overrides: Partial<Availability> = {}): Availability {
  return {
    region: 'GB',
    link: 'https://www.themoviedb.org/movie/129/watch?locale=GB',
    offers: [
      {
        providerId: 8,
        providerName: 'Netflix',
        logoPath: '/netflix.jpg',
        kind: 'FLATRATE',
        displayPriority: 1,
      },
    ],
    ...overrides,
  };
}

describe('AvailabilityBadges', () => {
  it('renders nothing when there is no availability', () => {
    const { container } = render(<AvailabilityBadges availability={null} title="Spirited Away" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the region has no offers', () => {
    // "We asked and there is nothing here" is stored as an empty row; an empty badge strip with a
    // heading and an attribution would be noise on every unavailable title.
    const { container } = render(
      <AvailabilityBadges availability={availability({ offers: [] })} title="Spirited Away" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names each provider as text', () => {
    render(<AvailabilityBadges availability={availability()} title="Spirited Away" />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('puts subscription offers before rentals and purchases', () => {
    render(
      <AvailabilityBadges
        title="Spirited Away"
        availability={availability({
          offers: [
            {
              providerId: 3,
              providerName: 'Buy Here',
              logoPath: null,
              kind: 'BUY',
              displayPriority: 1,
            },
            {
              providerId: 8,
              providerName: 'Stream Here',
              logoPath: null,
              kind: 'FLATRATE',
              displayPriority: 9,
            },
          ],
        })}
      />,
    );
    const names = screen.getAllByTestId('provider-name').map((n) => n.textContent);
    expect(names).toEqual(['Stream Here', 'Buy Here']);
  });

  it('labels how each offer is available', () => {
    render(<AvailabilityBadges availability={availability()} title="Spirited Away" />);
    expect(screen.getByText(/stream/i)).toBeInTheDocument();
  });

  it('opens the watch link safely', () => {
    render(<AvailabilityBadges availability={availability()} title="Spirited Away" />);
    const link = screen.getByRole('link', { name: /where to watch “Spirited Away”/i });
    expect(link).toHaveAttribute('target', '_blank');
    // The URL comes from a third party, so the opened page must not get a handle on this one.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the providers without a link rather than a dead one', () => {
    render(
      <AvailabilityBadges availability={availability({ link: null })} title="Spirited Away" />,
    );
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('carries the attribution the data source requires', () => {
    // TMDB's terms require naming JustWatch on any surface showing this data.
    render(<AvailabilityBadges availability={availability()} title="Spirited Away" />);
    expect(screen.getByText(/justwatch/i)).toBeInTheDocument();
  });

  it('renders a provider name containing markup as text', () => {
    const { container } = render(
      <AvailabilityBadges
        title="Spirited Away"
        availability={availability({
          offers: [
            {
              providerId: 1,
              providerName: '<img src=x onerror=alert(1)>',
              logoPath: null,
              kind: 'FLATRATE',
              displayPriority: 1,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('describes each logo for a screen reader', () => {
    render(<AvailabilityBadges availability={availability()} title="Spirited Away" />);
    expect(screen.getByAltText('Netflix')).toBeInTheDocument();
  });

  it('shows one badge per provider even when it offers several ways to watch', () => {
    render(
      <AvailabilityBadges
        title="Spirited Away"
        availability={availability({
          offers: [
            {
              providerId: 3,
              providerName: 'Apple TV',
              logoPath: null,
              kind: 'RENT',
              displayPriority: 1,
            },
            {
              providerId: 3,
              providerName: 'Apple TV',
              logoPath: null,
              kind: 'BUY',
              displayPriority: 1,
            },
          ],
        })}
      />,
    );
    // Otherwise a title available to rent and to buy from the same shop shows it twice.
    expect(screen.getAllByTestId('provider-name')).toHaveLength(1);
  });
});
