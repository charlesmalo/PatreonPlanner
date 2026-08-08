import { IsString, Length } from 'class-validator';

/**
 * Express's query parser yields arrays or objects for `?code[]=a&code[]=b`, so a bare
 * `@Query('code') code: string` is an assertion rather than a guarantee. Validating here also
 * satisfies design §9's requirement of class-validator DTOs on every endpoint, and bounds what
 * is forwarded to Patreon's token endpoint.
 */
export class PatreonCallbackQuery {
  @IsString()
  @Length(1, 512)
  code!: string;

  @IsString()
  @Length(1, 512)
  state!: string;
}
