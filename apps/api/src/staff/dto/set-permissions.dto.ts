import { ArrayUnique, IsArray, IsIn } from 'class-validator';
import { ALL_STAFF_PERMISSIONS, type StaffPermissionValue } from '../../access/permissions';

export class SetPermissionsDto {
  /**
   * The whole set, not a change to it. An empty array is a valid answer — a moderator who may do
   * nothing yet is a state an owner is allowed to create.
   */
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_STAFF_PERMISSIONS, { each: true })
  permissions!: StaffPermissionValue[];
}
