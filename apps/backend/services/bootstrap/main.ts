/**
 * PROJECT TITAN — backend entrypoint (Phase 1 fiat acquiring API).
 *
 * Run (after `tsc -b`): `node dist/services/bootstrap/main.js`.
 * Required env: DATABASE_URL, VIVA_CLIENT_ID, VIVA_CLIENT_SECRET, VIVA_SOURCE_CODE,
 * DEVICE_JWT_SECRET (and optionally VIVA_BASE_URL / VIVA_ACCOUNTS_URL for live).
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Reject unknown/invalid fields at the edge; the maskedPan regex on the DTO
  // already refuses anything resembling a full PAN.
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Titan acquiring API listening on :${port}`);
}

void bootstrap();
