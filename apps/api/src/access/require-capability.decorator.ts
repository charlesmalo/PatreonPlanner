import { SetMetadata } from '@nestjs/common';
import { Capability } from './capability';

export const REQUIRED_CAPABILITY = 'required-capability';

export const RequireCapability = (capability: Capability) =>
  SetMetadata(REQUIRED_CAPABILITY, capability);
