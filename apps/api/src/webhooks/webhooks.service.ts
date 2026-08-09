import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { PatreonEventDto } from './dto/patreon-event.dto';
import { WebhookCreator } from './webhook-signature.guard';

const HANDLED = new Set([
  'members:pledge:create',
  'members:pledge:update',
  'members:pledge:delete',
]);

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly memberships: MembershipSyncService,
    private readonly prisma: PrismaService,
  ) {}

  async handle(creator: WebhookCreator, trigger: string | undefined, body: unknown): Promise<void> {
    // Unhandled triggers are accepted and dropped before validation: Patreon's other events have
    // entirely different shapes and would fail a pledge schema, then retry forever.
    if (!trigger || !HANDLED.has(trigger)) return;

    const payload = plainToInstance(PatreonEventDto, body);
    const errors = await validate(payload, { whitelist: true });
    if (errors.length > 0) {
      // A pledge event we cannot trust the shape of must not be allowed to write authorization
      // state — writing zeros over a good membership would silently revoke access.
      this.logger.warn(`Rejecting malformed ${trigger}`);
      throw new BadRequestException('Invalid webhook payload');
    }

    const patreonUserId = payload.data?.relationships?.user?.data?.id;
    const campaignId = payload.data?.relationships?.campaign?.data?.id;
    if (!patreonUserId || !campaignId) {
      this.logger.warn(`Discarding ${trigger} with no user or campaign reference`);
      return;
    }

    // The secret proves the sender controls *this* creator's webhook; it does not stop them
    // naming someone else's campaign in the body. Without this check, one creator's leaked
    // secret would let them write memberships for every other creator.
    if (campaignId !== creator.patreonCampaignId) {
      this.logger.warn(
        `Discarding ${trigger} for campaign ${campaignId} delivered to creator ${creator.id}`,
      );
      return;
    }

    const attributes = payload.data?.attributes;
    // An event that validated but carries no attributes says nothing about patron status.
    // Treating that absence as "not a patron" would revoke access on a payload change.
    if (trigger !== 'members:pledge:delete' && !attributes) {
      this.logger.warn(`Discarding ${trigger} with no attributes`);
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { patreonUserId },
      select: { id: true },
    });
    // A patron who has never logged in has no User row to attach to. Login re-sync picks them
    // up; inventing a shell user here would create an account nobody can sign into.
    if (!user) return;

    const isDelete = trigger === 'members:pledge:delete';
    await this.memberships.applyIdentity(
      user.id,
      isDelete
        ? []
        : [
            {
              campaignId,
              patreonTierIds: (
                payload.data?.relationships?.currently_entitled_tiers?.data ?? []
              ).map((tier) => tier.id),
              amountCents: attributes?.currently_entitled_amount_cents ?? 0,
              isActivePatron: attributes?.patron_status === 'active_patron',
            },
          ],
      // Scoped: this event speaks only for its own campaign. Unscoped, an empty list from a
      // delete would revoke the user's access to every other creator they support.
      { onlyCampaignIds: [campaignId] },
    );
  }
}
