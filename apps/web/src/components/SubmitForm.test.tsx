import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmitForm } from './SubmitForm';
import { fakeApi, recommendation } from '../test-support';

describe('SubmitForm', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const setup = (onCreated = vi.fn()) => {
    render(<SubmitForm slug="ada-writes" onCreated={onCreated} />);
    return onCreated;
  };

  it('labels every field', () => {
    setup();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText(/why\?/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/link/i)).toBeInTheDocument();
  });

  it('blocks an empty title without a request', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(/give it a title/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the entry and hands it back', async () => {
    const created = recommendation({ id: 'new-1', customTitle: 'Akira' });
    global.fetch = fakeApi({ '/recommendations': { duplicate: false, recommendation: created } });
    const onCreated = setup();

    await userEvent.type(screen.getByLabelText('Title'), 'Akira');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(await screen.findByText(/pending review/i)).toBeInTheDocument();
    // Cleared, so a second suggestion does not resubmit the first.
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('explains a duplicate instead of pretending it was added', async () => {
    global.fetch = fakeApi({
      '/recommendations': { duplicate: true, recommendation: recommendation() },
    });
    setup();
    await userEvent.type(screen.getByLabelText('Title'), 'Spirited Away');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(/already on the board/i)).toBeInTheDocument();
  });

  it.each([
    [429, /try again a little later/i],
    [400, /rejected/i],
    [403, /for patrons at the required tier/i],
  ])('explains a %i from the server', async (status, expected) => {
    global.fetch = fakeApi({ '/recommendations': new Error(String(status)) });
    setup();
    await userEvent.type(screen.getByLabelText('Title'), 'Something');
    await userEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
