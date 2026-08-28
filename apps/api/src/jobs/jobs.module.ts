import { Global, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConfigService } from '../config/config.module';
import { AbuseDecayJob } from './abuse-decay.job';
import { AvailabilityRefreshJob } from './availability-refresh.job';
import { BillingReconcileJob } from '../billing/billing-reconcile.job';
import { BillingModule } from '../billing/billing.module';
import { CarryOverJob } from '../carry-over/carry-over.job';
import { CarryOverModule } from '../carry-over/carry-over.module';
import { EmbedTitlesJob } from './embed-titles.job';
import { EnrichTitleJob } from './enrich-title.job';
import { MembershipRefreshJob } from './membership-refresh.job';

const QUEUE = 'membership-refresh';
const EVERY_MS = 15 * 60 * 1000;

@Global()
@Module({
  // CarryOverModule rather than the job alone: the job's service needs the submission path, and
  // importing the module is how that arrives without re-registering half of it here.
  imports: [CarryOverModule, BillingModule],
  providers: [
    MembershipRefreshJob,
    AvailabilityRefreshJob,
    EnrichTitleJob,
    AbuseDecayJob,
    EmbedTitlesJob,
  ],
  exports: [
    MembershipRefreshJob,
    AvailabilityRefreshJob,
    EnrichTitleJob,
    AbuseDecayJob,
    EmbedTitlesJob,
  ],
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
    private readonly abuseDecayJob: AbuseDecayJob,
    private readonly embedJob: EmbedTitlesJob,
    private readonly carryOverJob: CarryOverJob,
    private readonly billingJob: BillingReconcileJob,
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
        // Each isolated, and decay first. Sharing one tick is fine — all of these are bounded
        // and idempotent — but an unguarded chain meant a failure in any job skipped the rest,
        // and decay is the *only* thing that ever reduces a strike count. A persistently
        // failing upstream job would have quietly turned a capped, decaying penalty into an
        // accumulating one, which design §6.4 forbids.
        await this.runJob('abuse decay', () => this.abuseDecayJob.runOnce());
        await this.runJob('membership refresh', () => this.job.runOnce());
        await this.runJob('tier resync', () => this.job.resyncTiers());
        await this.runJob('availability refresh', () => this.availabilityJob.runOnce());
        await this.runJob('title enrichment', () => this.enrichJob.runOnce());
        await this.runJob('title embedding', () => this.embedJob.runOnce());
        // Last: it is the only job that writes to other people's boards, so everything that keeps
        // the app honest — decay, memberships, moderation inputs — is already current when it runs.
        await this.runJob('carry-over delivery', () => this.carryOverJob.runOnce());
        // Ahead of nothing in particular, but isolated like the rest: a provider being down must
        // not stop the jobs that keep strikes decaying and memberships current.
        await this.runJob('billing reconciliation', () => this.billingJob.runOnce());
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

  private async runJob(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Job "${name}" failed: ${(error as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Closed in order: the worker stops accepting first, so nothing is mid-flight when the
    // queue's connection goes.
    await this.worker?.close();
    await this.queue?.close();
  }
}
