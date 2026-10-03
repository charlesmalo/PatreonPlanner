import { renderHook, waitFor, act } from '@testing-library/react';
import { useRegion } from './use-region';
import { fakeApi } from '../test-support';

const META = 'GET /api/v1/meta/regions';
const served = { regions: ['US', 'GB', 'FR'], default: 'US' };

describe('useRegion', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    window.localStorage.clear();
  });

  it('starts with no choice, so the server&apos;s default applies', async () => {
    global.fetch = fakeApi({ [META]: served });
    const { result } = renderHook(() => useRegion());

    await waitFor(() => expect(result.current.regions).toHaveLength(3));
    expect(result.current.region).toBeNull();
    expect(result.current.fallback).toBe('US');
  });

  it('remembers a choice across a remount', async () => {
    // A preference that has to be re-made on every visit is not a preference.
    global.fetch = fakeApi({ [META]: served });
    const first = renderHook(() => useRegion());
    await waitFor(() => expect(first.result.current.regions).toHaveLength(3));
    act(() => first.result.current.setRegion('GB'));
    first.unmount();

    const second = renderHook(() => useRegion());

    await waitFor(() => expect(second.result.current.region).toBe('GB'));
  });

  it('drops a stored choice the server no longer serves', async () => {
    // An operator can shorten AVAILABILITY_REGIONS at any time. A reader who picked a country
    // that has since gone would otherwise send it on every board read and get a 400 — a board
    // that worked yesterday and is broken today, over a setting they cannot see.
    window.localStorage.setItem('pp.availability.region', 'JP');
    global.fetch = fakeApi({ [META]: served });
    const { result } = renderHook(() => useRegion());

    await waitFor(() => expect(result.current.regions).toHaveLength(3));
    expect(result.current.region).toBeNull();
  });

  it('keeps working when the region list cannot be read', async () => {
    // Availability is garnish on a board that works without it. Failing here must not take the
    // board with it — every card still gets the server's own default.
    global.fetch = fakeApi({ [META]: new Error('500') });
    const { result } = renderHook(() => useRegion());

    await waitFor(() => expect(result.current.regions).toEqual([]));
    expect(result.current.region).toBeNull();
  });

  it('survives a body without a regions array', async () => {
    global.fetch = fakeApi({ [META]: {} });
    const { result } = renderHook(() => useRegion());

    await waitFor(() => expect(result.current.regions).toEqual([]));
    expect(result.current.fallback).toBeNull();
  });

  it('still applies a choice when storage refuses it', async () => {
    // Private windows throw on write. The choice should hold for this visit rather than appear
    // not to register at all.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    global.fetch = fakeApi({ [META]: served });
    const { result } = renderHook(() => useRegion());
    await waitFor(() => expect(result.current.regions).toHaveLength(3));

    act(() => result.current.setRegion('FR'));

    expect(result.current.region).toBe('FR');
    setItem.mockRestore();
  });
});
