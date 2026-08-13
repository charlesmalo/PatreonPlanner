import { Injectable } from '@nestjs/common';
import { AbuseService } from '../abuse/abuse.service';

@Injectable()
export class AbuseDecayJob {
  constructor(private readonly abuse: AbuseService) {}

  /** Design §6.4's "decays with good behaviour". Bounded by the service's batch size. */
  runOnce(): Promise<number> {
    return this.abuse.decayOnce();
  }
}
