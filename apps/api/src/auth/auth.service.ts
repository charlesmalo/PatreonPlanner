import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PATREON_CLIENT, PatreonClient } from '../patreon/patreon.client';
import { PatreonTokens } from '../patreon/patreon.types';
import { MembershipSyncService } from '../memberships/membership-sync.service';
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

    await this.memberships.applyIdentity(user.id, identity.memberships);

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
