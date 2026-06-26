/**
 * PROJECT TITAN — root application module (Phase 1 fiat acquiring).
 * Compose feature modules here (Viva acquiring; later: crypto, compliance, …).
 */
import { Module } from '@nestjs/common';
import { VivaAcquiringModule } from '../viva/viva.module';

@Module({
  imports: [VivaAcquiringModule],
})
export class AppModule {}
