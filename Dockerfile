# ── Сборка (компиляция native модулей) ───────────────────────────────
FROM node:20-alpine AS builder

# Инструменты для компиляции better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /build
COPY package*.json ./
RUN npm ci --production

# ── Финальный образ ───────────────────────────────────────────────────
FROM node:20-alpine

# Инструмент для ping (нужен для мониторинга)
RUN apk add --no-cache iputils

WORKDIR /app

# Копируем скомпилированные зависимости из builder
COPY --from=builder /build/node_modules ./node_modules

# Копируем исходный код
COPY server.js .
COPY public/ ./public/
COPY package.json .

# data/ — персистентный том (устройства, база, сертификаты)
VOLUME ["/app/data"]

EXPOSE 9222

# Healthcheck — сервер отвечает на /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9222/api/health || exit 1

CMD ["node", "server.js"]
