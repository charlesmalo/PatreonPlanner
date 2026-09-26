import { IsString, Length } from 'class-validator';

export class RedeemDto {
  /**
   * What the spender wants played — an episode, a chapter, a specific video.
   *
   * Free text rather than a catalogue reference: nothing in this system models an episode, so
   * "S2E04" is a sentence the creator reads rather than a row the system resolves. It is the
   * whole instruction, which is why an empty one is refused in the service.
   */
  @IsString()
  @Length(1, 200)
  note!: string;
}
