FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/game-api/package.json services/game-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY services/game-api services/game-api
RUN npm run build -w @paint-arena/shared \
  && npm run build -w @paint-arena/game-api \
  && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001 HOST=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/services/game-api/package.json ./services/game-api/package.json
COPY --from=build /app/services/game-api/dist ./services/game-api/dist
USER app
EXPOSE 3001
CMD ["node", "services/game-api/dist/index.js"]
