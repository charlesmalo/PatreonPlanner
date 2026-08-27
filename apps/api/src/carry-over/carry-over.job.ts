import { Injectable } from '@nestjs/common';
import { CarryOverService } from './carry-over.service';

@Injectable()
export class CarryOverJob {
  constructor(private readonly carryOver: CarryOverService) {}

  /** Amendment A.3: the queue drains at each board's own rate. Bounded by the service's batch. */
  runOnce(): Promise<number> {
    return this.carryOver.runOnce();
  }
}
