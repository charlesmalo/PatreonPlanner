import { Global, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConfigService } from '../config/config.module';
import { AvailabilityRefreshJob } from './availability-refresh.job';
import { EnrichTitleJob } from './enrich-title.job';
import { MembershipRefreshJob } from './membership-refresh.job';

const QUEUE = 'membership-refresh';
const EVERY_MS = 15 * 60 * 1000;

@Global()
@Module({
  providers: [MembershipRefreshJob, AvailabilityRefreshJob, EnrichTitleJob],
  exports: [MembershipRefreshJob, AvailabilityRefreshJob, EnrichTitleJob],
})
export class JobsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsModule.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly job: MembershipRefreshJob,
    private readonly availabilityJob: AvailabilityRefreshJob,
    private readonly enrichJob: EnrichTitleJob,
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
        // Same tick rather than its own queue: both are bounded, both are idempotent, and a
        // second repeatable job is a second thing to get wrong for no gain at this scale.
        await this.availabilityJob.runOnce();
        await this.enrichJob.runOnce();
      },
      { connection },
    );
    // BullMQ swallows an unhandled 'error' into a bare console.error, so Redis failures and
    // failed ticks would otherwise appear nowhere structured.
    this.worker.on('failed', (_job, error) =>
      this.logger.error(`Membership refresh tick failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`Job worker error: ${error.message}`));
    this.queue.on('error', (error) => this.logger.error(`Job queue error: ${error.message}`));
    // A fixed jobId means every API instance schedules the same repeatable job rather than one
    // copy each.
    await this.queue.add(
      'tick',
      {},
      {
        repeat: { every: EVERY_MS },
        jobId: 'membership-refresh-tick',
        // Bounded history: ~96 ticks a day would otherwise accumulate in Redis forever.
        removeOnComplete: 24,
        removeOnFail: 48,
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // Closed in order: the worker stops accepting first, so nothing is mid-flight when the
    // queue's connection goes.
    await this.worker?.close();
    await this.queue?.close();
  }
}
