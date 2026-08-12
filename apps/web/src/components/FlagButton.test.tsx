import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlagButton } from './FlagButton';
import { fakeApi } from '../test-support';

describe('FlagButton', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const renderButton = () =>
    render(<FlagButton slug="ada-writes" recommendationId="rec-1" title="Spirited Away" />);

  it('opens a labelled reason picker', async () => {
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /report “Spirited Away”/i }));
    expect(screen.getByLabelText(/reason/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what is wrong/i)).toBeInTheDocument();
  });

  it('posts the report and confirms it', async () => {
    const fetchMock = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': {
        id: 'flag-1',
        status: 'OPEN',
        duplicate: false,
      },
    });
    global.fetch = fetchMock;
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /report “Spirited Away”/i }));
    await userEvent.selectOptions(screen.getByLabelText(/reason/i), 'SPAM');
    await userEvent.type(screen.getByLabelText(/what is wrong/i), 'link farm');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/thanks/i);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ reason: 'SPAM', note: 'link farm' });
  });

  it('says so when the viewer already reported this entry', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': {
        id: 'flag-1',
        status: 'OPEN',
        duplicate: true,
      },
    });
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /report “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/already reported/i);
  });

  it('omits an empty note rather than sending a blank string', async () => {
    const fetchMock = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': { duplicate: false },
    });
    global.fetch = fetchMock;
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /report “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reason: 'SPAM' });
  });

  it('tells an anonymous viewer to sign in rather than failing silently', async () => {
    global.fetch = fakeApi({
      'POST /api/v1/creators/ada-writes/recommendations/rec-1/flags': new Error('401'),
    });
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: /report “Spirited Away”/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/sign in/i);
  });
});
