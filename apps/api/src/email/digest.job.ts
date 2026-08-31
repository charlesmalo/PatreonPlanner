import { Injectable } from '@nestjs/common';
import { DigestService } from './digest.service';

@Injectable()
export class DigestJob {
  constructor(private readonly digest: DigestService) {}

  /** One email a day per reader who asked for one. Bounded by the service's batch. */
  runOnce(): Promise<number> {
    return this.digest.runOnce();
  }
}
