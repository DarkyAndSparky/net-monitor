# node:sqlite встроен в Node.js >= 22.5.0 — никакой компиляции не нужно
FROM node:22-alpine

# ping для мониторинга
RUN apk add --no-cache iputils

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY server.js .
COPY public/ ./public/
COPY src/ ./src/

VOLUME ["/app/data"]
EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9222/api/health || exit 1

CMD ["node", "server.js"]
