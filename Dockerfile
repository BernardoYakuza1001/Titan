# PROJECT TITAN — backend container (for any Docker host: Railway, Fly.io, a VPS…).
# Mirrors the verified npm-workspace build. Provide env vars at runtime (VIVA_*,
# DEVICE_JWT_SECRET, DATABASE_URL). Migrations run on start (idempotent).
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm install && npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/migrations ./apps/backend/migrations
COPY --from=build /app/apps/backend/scripts ./apps/backend/scripts
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
EXPOSE 3000
CMD ["sh", "-c", "node apps/backend/scripts/migrate.mjs && node apps/backend/dist/services/bootstrap/main.js"]
