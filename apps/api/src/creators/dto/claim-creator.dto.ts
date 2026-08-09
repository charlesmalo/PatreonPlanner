import { IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class ClaimCreatorDto {
  @IsString()
  @Length(1, 64)
  patreonCampaignId!: string;

  // The creator's own site, used by the Phase 4 extension. Restricted to http(s) so a
  // javascript: or data: URL can never be stored and later rendered as a link.
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2048)
  baseUrl?: string;
}
