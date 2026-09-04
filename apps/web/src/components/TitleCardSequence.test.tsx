import { render, screen, within } from '@testing-library/react';
import { TitleCardSequence } from './TitleCardSequence';

/**
 * The animation is decorative; the words are not.
 *
 * Nothing here can assert what the movement looks like — jsdom computes no keyframes — and that is
 * the point of the tests that follow. They pin the guarantee that survives when the animation does
 * not run at all: on a system asking for less motion, in a crawler, or read aloud, the three stages
 * are present, in order, as ordinary text.
 */
describe('TitleCardSequence', () => {
  it('spells the slogan out as text rather than implying it', () => {
    render(<TitleCardSequence />);

    for (const word of ['Pitch.', 'Plan.', 'Play.']) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
  });

  it('keeps the stages in the order the slogan depends on', () => {
    // Left to right is load-bearing: a patron pitches, the creator plans it in, it plays. A
    // sequence that reads back in another order describes a workflow the product does not have.
    render(<TitleCardSequence />);

    const stages = screen.getAllByRole('listitem');
    expect(stages).toHaveLength(3);
    expect(stages[0]).toHaveTextContent('Pitch.');
    expect(stages[1]).toHaveTextContent('Plan.');
    expect(stages[2]).toHaveTextContent('Play.');
  });

  it('names a real column beside each stage', () => {
    // The cards claim to be a board. Naming columns that exist is what keeps that honest.
    render(<TitleCardSequence />);

    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Now Playing')).toBeInTheDocument();
  });

  it('is a list, so it is read as a sequence rather than three loose cards', () => {
    render(<TitleCardSequence />);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('says what each stage means, so the words are not the only clue', () => {
    render(<TitleCardSequence />);

    expect(screen.getByText(/a patron puts something forward/i)).toBeInTheDocument();
    expect(screen.getByText(/you decide it is happening/i)).toBeInTheDocument();
    expect(screen.getByText(/reaches the top of the queue/i)).toBeInTheDocument();
  });
});
