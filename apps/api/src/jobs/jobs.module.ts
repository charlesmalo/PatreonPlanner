import { Global, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConfigService } from '../config/config.module';
import { MembershipRefreshJob } from './membership-refresh.job';

const QUEUE = 'membership-refresh';
const EVERY_MS = 15 * 60 * 1000;

@Global()
@Module({ providers: [MembershipRefreshJob], exports: [MembershipRefreshJob] })
export class JobsModule implements OnModuleInit, OnApplicationShutdown {
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly job: MembershipRefreshJob,
  ) {}

  async onModuleInit(): Promise<void> {
    // Disabled in tests, where a scheduler firing mid-assertion is pure flake. The job methods
    // stay directly callable, which is what the suites exercise.
    if (!this.config.get('JOBS_ENABLED')) return;

    const connection = { url: this.config.get('REDIS_URL') };
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(
      QUEUE,
      async () => {
        await this.job.runOnce();
        await this.job.resyncTiers();
      },
      { connection },
    );
    // A fixed jobId means every API instance schedules the same repeatable job rather than one
    // copy each.
    await this.queue.add(
      'tick',
      {},
      { repeat: { every: EVERY_MS }, jobId: 'membership-refresh-tick' },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // Closed in order: the worker stops accepting first, so nothing is mid-flight when the
    // queue's connection goes.
    await this.worker?.close();
    await this.queue?.close();
  }
}
