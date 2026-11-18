# Stage 1: Build
FROM node:20-alpine AS builder

# git is required: @whiskeysockets/baileys depends on a git-hosted package (libsignal)
RUN apk add --no-cache git

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /usr/src/app

# Install system dependencies if needed (ffmpeg is often required for WhatsApp media)
# ffmpeg-static usually handles it, but having it on system is safe fallback
RUN apk add --no-cache ffmpeg git

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/dist ./dist
# We might need src/db/migrations if we run migrations from source or compiled? 
# TypeORM usually needs to know where entities/migrations are.
# In dist, they should be compiled js files.

# Copy public folder if exists
COPY public ./public

EXPOSE 5000

CMD ["npm", "start"]
