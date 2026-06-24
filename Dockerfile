# Stable Bun 1.x on Alpine Linux — https://hub.docker.com/r/oven/bun/tags?name=1-alpine
ARG BUN_IMAGE=oven/bun:1-alpine

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

RUN addgroup -g 1001 appuser \
 && adduser -D -u 1001 -G appuser -h /home/appuser appuser

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DB_PATH=/data/portfolio.db
ENV HOST=0.0.0.0
ENV PORT=3000

RUN mkdir -p /data && chown appuser:appuser /data
USER appuser
VOLUME /data
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
