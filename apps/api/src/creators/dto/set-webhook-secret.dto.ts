import { IsString, Length } from 'class-validator';

export class SetWebhookSecretDto {
  /** Copied from Patreon's developer portal when the creator registers their webhook. */
  @IsString()
  @Length(1, 256)
  secret!: string;
}
