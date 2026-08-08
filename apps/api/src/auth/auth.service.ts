import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonIdentity, PatreonTokens } from '../patreon/patreon.types';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { OAuthStateService } from './oauth-state.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly states: OAuthStateService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly sessions: SessionService,
  ) {}

  /** Returns the redirect target plus the state, which the caller binds to the browser. */
  async startLogin(): Promise<{ url: string; state: string }> {
    const { state, codeChallenge } = await this.states.start();
    return { url: this.patreon.buildAuthorizationUrl({ state, codeChallenge }), state };
  }

  async completeLogin(code: string, state: string): Promise<string> {
    const codeVerifier = await this.states.consume(state);
    if (!codeVerifier) {
      // A forged state, an expired one and a replay are deliberately indistinguishable to the
      // caller, so the response cannot be used to probe which of the three occurred.
      throw new UnauthorizedException('Invalid authentication request');
    }

    const tokens = await this.patreon.exchangeCode(code, codeVerifier);
    const identity = await this.patreon.fetchIdentity(tokens.accessToken);

    const profile = {
      fullName: identity.fullName,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      ...this.encryptedTokenFields(tokens),
    };
    const user = await this.prisma.user.upsert({
      where: { patreonUserId: identity.patreonUserId },
      create: { patreonUserId: identity.patreonUserId, ...profile },
      update: profile,
    });

    await this.syncMemberships(user.id, identity);

    // Rotation on login: a session is always freshly minted, so a token captured beforehand is
    // never the one that ends up authenticated.
    return this.sessions.create(user.id);
  }

  private encryptedTokenFields(tokens: PatreonTokens) {
    return {
      accessTokenEncrypted: this.encryption.encrypt(tokens.accessToken),
      refreshTokenEncrypted: this.encryption.encrypt(tokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
    };
  }

  /**
   * Only a campaign already claimed as a Creator can produce a Membership row. Claiming
   * arrives in Plan 03; until then an unclaimed campaign is skipped rather than half-created
   * against a tenant that does not exist yet.
   */
  private async syncMemberships(userId: string, identity: PatreonIdentity): Promise<void> {
    const syncedCreatorIds: string[] = [];
    for (const membership of identity.memberships) {
      const creator = await this.prisma.creator.findUnique({
        where: { patreonCampaignId: membership.campaignId },
      });
      if (!creator) continue;

      const patreonTierId = membership.patreonTierIds[0];
      const tier = patreonTierId
        ? await this.prisma.tier.findUnique({
            where: { creatorId_patreonTierId: { creatorId: creator.id, patreonTierId } },
          })
        : null;

      const state = {
        currentTierId: tier?.id ?? null,
        amountCents: membership.amountCents,
        isActivePatron: membership.isActivePatron,
        lastSyncedAt: new Date(),
      };
      await this.prisma.membership.upsert({
        where: { userId_creatorId: { userId, creatorId: creator.id } },
        create: { userId, creatorId: creator.id, ...state },
        update: state,
      });
      syncedCreatorIds.push(creator.id);
    }

    // Patreon reports current memberships only, so a lapsed one simply stops appearing. Without
    // this, login re-sync could grant access but never revoke it — and design §4 makes this the
    // fallback for the webhook path, which a grant-only sync would not actually be.
    await this.prisma.membership.updateMany({
      where: { userId, creatorId: { notIn: syncedCreatorIds } },
      data: { isActivePatron: false, currentTierId: null, lastSyncedAt: new Date() },
    });
  }
}
