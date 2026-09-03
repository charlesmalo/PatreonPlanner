import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonIdentity, PatreonProfile, PatreonTokens } from '../patreon/patreon.types';
import { MembershipSyncService } from '../memberships/membership-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { OAuthStateService } from './oauth-state.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly states: OAuthStateService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly sessions: SessionService,
    private readonly memberships: MembershipSyncService,
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

    /**
     * Null when Patreon could not tell us what they support.
     *
     * Their identity endpoint is reported to time out for readers with many memberships —
     * server-side, at around ten seconds, and not helped by paging or trimming fields. Requiring
     * it meant the people supporting the most creators could not sign in at all rather than now
     * and then, which is the wrong way round: those are the readers with the most to lose.
     *
     * So a failure here degrades instead of refusing. What it must never do is continue with an
     * empty list — `applyIdentity` deactivates every membership absent from what it is given, so
     * treating "we did not ask" as "they support nobody" would revoke every board they pay for at
     * the moment they signed in. `fetchProfile` returns a type with no memberships field at all,
     * which makes that a compile error rather than something to remember.
     */
    let identity: PatreonIdentity | null = null;
    try {
      identity = await this.patreon.fetchIdentity(tokens.accessToken);
    } catch (error) {
      this.logger.warn(
        `Patreon could not report memberships at login; signing in without them: ${
          (error as Error).message
        }`,
      );
    }
    // Not caught: with no id there is no reader to sign in, and inventing one is worse than
    // refusing. The fallback is about degrading, not about guessing.
    const who: PatreonProfile = identity ?? (await this.patreon.fetchProfile(tokens.accessToken));

    const profile = {
      fullName: who.fullName,
      email: who.email,
      avatarUrl: who.avatarUrl,
      ...this.encryptedTokenFields(tokens),
      // Cleared only on the fallback, so the background refresh picks them up first — it orders
      // by this stamp with nulls first. On the ordinary path it is left alone: memberships were
      // just applied, and clearing it would claim nothing had been learned.
      //
      // The flag beside it carries the case the stamp cannot. A reader signing in for the first
      // time has no memberships at all, so the job's "has a stale membership" selector would
      // never look at them again — they would sign in once and never receive access to anything
      // they pay for. `applyIdentity` clears it on the ordinary path.
      ...(identity ? {} : { membershipsRefreshedAt: null, membershipsSyncPending: true }),
    };
    const user = await this.prisma.user.upsert({
      where: { patreonUserId: who.patreonUserId },
      create: { patreonUserId: who.patreonUserId, ...profile },
      update: profile,
    });

    if (identity) await this.memberships.applyIdentity(user.id, identity.memberships);

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
}
