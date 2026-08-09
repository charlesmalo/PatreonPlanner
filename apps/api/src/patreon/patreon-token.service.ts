import { Inject, Injectable } from '@nestjs/common';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { PATREON_CLIENT, PatreonClient } from './patreon.client';

// Refresh a little early: a token still valid at the moment of the check could expire in
// flight, and the resulting failure would surface to the caller as a permissions problem.
const EXPIRY_SKEW_MS = 60_000;

@Injectable()
export class PatreonTokenService {
  constructor(
    @Inject(PATREON_CLIENT) private readonly patreon: PatreonClient,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Returns a usable plaintext access token, refreshing and persisting it when needed. */
  async getAccessToken(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accessTokenEncrypted: true, refreshTokenEncrypted: true, tokenExpiresAt: true },
    });
    if (!user?.accessTokenEncrypted || !user.refreshTokenEncrypted) {
      throw new Error('No Patreon token for user');
    }

    const stillValid =
      user.tokenExpiresAt && user.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
    if (stillValid) return this.encryption.decrypt(user.accessTokenEncrypted);

    const refreshed = await this.patreon.refreshTokens(
      this.encryption.decrypt(user.refreshTokenEncrypted),
    );
    // Patreon rotates the refresh token too, so both halves must be persisted or the next
    // refresh presents one that has already been spent.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accessTokenEncrypted: this.encryption.encrypt(refreshed.accessToken),
        refreshTokenEncrypted: this.encryption.encrypt(refreshed.refreshToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
      },
    });
    return refreshed.accessToken;
  }
}
