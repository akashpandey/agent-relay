FROM node:22-alpine

# Install tzdata for proper IST timezone handling and procps for process management
RUN apk add --no-cache tzdata procps

ENV TZ=Asia/Kolkata
ENV PORT=4242
ENV HOST=0.0.0.0
ENV LOGS_DIR=/app/logs
ENV PROC_DIR=/proc

WORKDIR /app

# Copy package definition
COPY package.json ./

# Copy dashboard app code and public assets
COPY server.js parser.js ./
COPY public ./public

EXPOSE 4242

CMD ["node", "server.js"]
