FROM node:20-alpine

WORKDIR /app

# Add tailscale CLI (same as controller)
RUN apk add --no-cache bash curl iptables ip6tables iproute2 openresolv \
   && wget -qO- https://pkgs.tailscale.com/stable/tailscale_1.66.4_amd64.tgz \
   | tar -xz -C /usr/local/bin --strip-components=1 tailscale_1.66.4_amd64/tailscale

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
COPY state/ ./state/

CMD ["sh", "start.sh"]
