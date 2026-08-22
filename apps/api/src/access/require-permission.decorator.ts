import { SetMetadata } from '@nestjs/common';
import type { StaffPermissionValue } from './permissions';

export const REQUIRED_PERMISSION = 'requiredPermission';

/**
 * The finer half of a moderated endpoint's gate. `RequireCapability('MODERATE')` still answers
 * "is this person staff here"; this answers "and may they do this in particular".
 *
 * Both, never one: without the capability the guard never resolves a staff row to read
 * permissions from.
 */
export const RequirePermission = (permission: StaffPermissionValue) =>
  SetMetadata(REQUIRED_PERMISSION, permission);
