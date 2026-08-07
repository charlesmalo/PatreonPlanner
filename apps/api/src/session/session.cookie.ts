/**
 * Defined on its own so the controller and the guard share one name. Two independent string
 * literals would drift silently: the guard would simply stop finding the cookie the controller
 * sets, and every request would look unauthenticated.
 */
export const SESSION_COOKIE = 'pp_session';
