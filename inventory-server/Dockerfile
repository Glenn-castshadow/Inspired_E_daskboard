# ---- Build stage: compile native modules (better-sqlite3 needs build tools) ----
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ---- Production stage ----
FROM node:20-alpine
WORKDIR /app

# Copy compiled node_modules from builder (no build tools in final image)
COPY --from=builder /app/node_modules ./node_modules

# Copy server source
COPY . .

# Persistent data directory — mount a named volume here
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/inventory.db

EXPOSE 3456
CMD ["node", "server.js"]
