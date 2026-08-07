import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OAuthStateService } from './oauth-state.service';

@Module({ controllers: [AuthController], providers: [AuthService, OAuthStateService] })
export class AuthModule {}
