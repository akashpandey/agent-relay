FROM node:22-alpine

# Install tzdata, procps, and sqlite for historical prompt lookups
RUN apk add --no-cache tzdata procps sqlite

ENV TZ=Asia/Kolkata
ENV PORT=4242
ENV HOST=0.0.0.0
ENV LOGS_DIR=/app/logs
ENV PROC_DIR=/proc
ENV OPENCODE_DB=/opencode_data/opencode.db
ENV GEMINI_BRAIN=/gemini_brain
ENV CLAUDE_DATA=/claude_data
ENV CODEX_DATA=/codex_data

WORKDIR /app

# Copy package definition
COPY package.json ./

# Copy dashboard app code and public assets
COPY server.js parser.js db.js sync-logs.js ./
COPY public ./public

EXPOSE 4242

CMD ["node", "server.js"]
