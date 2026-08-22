import type { StaffRoleValue } from './capability';

/**
 * What a moderator may do, beyond being staff at all.
 *
 * One per thing moderators actually do today, each mapping to endpoints that already exist.
 * Anything finer would invent distinctions nobody has asked for.
 */
export type StaffPermissionValue =
  | 'MOVE_ENTRIES'
  | 'EDIT_ENTRIES'
  | 'HANDLE_REPORTS'
  | 'WRITE_NOTES'
  | 'MANAGE_THEMES';

export const ALL_STAFF_PERMISSIONS: StaffPermissionValue[] = [
  'MOVE_ENTRIES',
  'EDIT_ENTRIES',
  'HANDLE_REPORTS',
  'WRITE_NOTES',
  'MANAGE_THEMES',
];

interface PermissionViewer {
  isAuthenticated: boolean;
  staffRole: StaffRoleValue | null;
  permissions: StaffPermissionValue[];
}

/**
 * Pure, like `can` beside it: authorization is the part most worth exhaustive testing, and it
 * should be testable without a database standing behind it.
 *
 * Fails closed twice over. A permission absent from the set is denied, and a set attached to
 * someone who is not staff here is ignored rather than honoured — that combination is a bug
 * upstream, not a grant.
 */
export function hasPermission(viewer: PermissionViewer, permission: StaffPermissionValue): boolean {
  if (!viewer.isAuthenticated || viewer.staffRole === null) return false;
  // Short-circuit rather than a granted full set: an owner whose permissions could be edited is
  // an owner who can be locked out of their own board.
  if (viewer.staffRole === 'OWNER') return true;
  return viewer.permissions.includes(permission);
}
