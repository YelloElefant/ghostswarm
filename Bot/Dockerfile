FROM node:20-alpine

WORKDIR /app

# Add tailscale CLI with correct architecture detection
RUN apk add --no-cache bash curl iptables ip6tables iproute2 openresolv \
   && ARCH=$(uname -m) \
   && case $ARCH in \
   x86_64) TAILSCALE_ARCH="amd64" ;; \
   aarch64) TAILSCALE_ARCH="arm64" ;; \
   armv7l) TAILSCALE_ARCH="arm" ;; \
   *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
   esac \
   && echo "Downloading Tailscale for architecture: $TAILSCALE_ARCH" \
   && wget -qO- https://pkgs.tailscale.com/stable/tailscale_1.66.4_${TAILSCALE_ARCH}.tgz \
   | tar -xz -C /usr/local/bin --strip-components=1 tailscale_1.66.4_${TAILSCALE_ARCH}/tailscale

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
