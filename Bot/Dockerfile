FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY bot.js ./
COPY config.js ./
COPY commands/ ./commands/
COPY heartbeat/ ./heartbeat/
COPY mqtt/ ./mqtt/
COPY torrent/ ./torrent/
COPY seed.js ./
COPY start.sh ./




CMD ["sh", "start.sh"]
