import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

class ResourceRef {
  @IsString()
  id!: string;
}

class RefWrapper {
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceRef)
  data?: ResourceRef;
}

class RefListWrapper {
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ResourceRef)
  data?: ResourceRef[];
}

class PledgeAttributes {
  @IsOptional()
  @IsString()
  patron_status?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currently_entitled_amount_cents?: number;

  @IsOptional()
  @IsBoolean()
  is_follower?: boolean;
}

class PledgeRelationships {
  @IsOptional()
  @ValidateNested()
  @Type(() => RefWrapper)
  user?: RefWrapper;

  @IsOptional()
  @ValidateNested()
  @Type(() => RefWrapper)
  campaign?: RefWrapper;

  @IsOptional()
  @ValidateNested()
  @Type(() => RefListWrapper)
  currently_entitled_tiers?: RefListWrapper;
}

class PledgeData {
  @IsOptional()
  @ValidateNested()
  @Type(() => PledgeAttributes)
  attributes?: PledgeAttributes;

  @IsOptional()
  @ValidateNested()
  @Type(() => PledgeRelationships)
  relationships?: PledgeRelationships;
}

/**
 * Validates the shape before it is allowed to write authorization state. Without this, a payload
 * whose `attributes` moved or was renamed would silently read as `amountCents: 0` and
 * `isActivePatron: false` — revoking every patron who triggers an event, with a 204 telling
 * Patreon everything is fine.
 */
export class PatreonEventDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => PledgeData)
  data?: PledgeData;
}
