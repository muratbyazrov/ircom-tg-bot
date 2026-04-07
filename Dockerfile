FROM node:22-alpine AS builder

WORKDIR /app

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Pre-create data directory for SQLite
RUN mkdir -p /app/data

CMD ["node", "bot.js"]
