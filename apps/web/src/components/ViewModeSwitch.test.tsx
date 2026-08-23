import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewModeSwitch } from './ViewModeSwitch';

describe('ViewModeSwitch', () => {
  const setup = (props: Partial<Parameters<typeof ViewModeSwitch>[0]> = {}) => {
    const onChange = vi.fn();
    render(<ViewModeSwitch mode="moderator" onChange={onChange} needsAck={false} {...props} />);
    return onChange;
  };

  it('names both modes rather than showing a bare toggle', async () => {
    setup();

    const select = screen.getByLabelText(/viewing as/i);
    expect(select).toHaveValue('moderator');
    expect(screen.getByRole('option', { name: /patron/i })).toBeInTheDocument();
  });

  it('switches to patron view without asking anything', async () => {
    // Nothing can go wrong: giving up powers is not a decision worth confirming.
    const onChange = setup();

    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'patron');

    expect(onChange).toHaveBeenCalledWith('patron');
  });

  it('asks before switching into moderator view after a long idle', async () => {
    // The case this exists for: a tab left open overnight, picked up, and edited by accident.
    const onChange = setup({ mode: 'patron', needsAck: true });

    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'moderator');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(/moderator/i);
  });

  it('switches once the reader confirms', async () => {
    const onChange = setup({ mode: 'patron', needsAck: true });
    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'moderator');

    await userEvent.click(screen.getByRole('button', { name: /^continue/i }));

    expect(onChange).toHaveBeenCalledWith('moderator', false);
  });

  it('stays put when the reader declines', async () => {
    const onChange = setup({ mode: 'patron', needsAck: true });
    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'moderator');

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/viewing as/i)).toHaveValue('patron');
  });

  it('can be told not to ask again', async () => {
    const onChange = setup({ mode: 'patron', needsAck: true });
    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'moderator');

    await userEvent.click(screen.getByLabelText(/do not ask/i));
    await userEvent.click(screen.getByRole('button', { name: /^continue/i }));

    expect(onChange).toHaveBeenCalledWith('moderator', true);
  });

  it('does not ask on a session that has been in use', async () => {
    const onChange = setup({ mode: 'patron', needsAck: false });

    await userEvent.selectOptions(screen.getByLabelText(/viewing as/i), 'moderator');

    expect(onChange).toHaveBeenCalledWith('moderator');
  });
});
