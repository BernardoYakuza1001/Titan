/**
 * PROJECT TITAN — SecurityModule. Provides the device-auth guard + its verifier,
 * exported so feature modules (e.g. VivaAcquiringModule) can @UseGuards it.
 */
import { Module } from '@nestjs/common';
import { DeviceAuthGuard, JwtDeviceVerifier } from './device-auth.guard';
import { DEVICE_VERIFIER } from '../tokens';

@Module({
  providers: [
    DeviceAuthGuard,
    {
      provide: DEVICE_VERIFIER,
      // HS256 demo secret from env. Production: RS256 with the Auth service's public key.
      useFactory: () => new JwtDeviceVerifier(process.env.DEVICE_JWT_SECRET ?? 'dev-insecure-change-me'),
    },
  ],
  exports: [DeviceAuthGuard, DEVICE_VERIFIER],
})
export class SecurityModule {}
