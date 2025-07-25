FROM node:20-alpine

WORKDIR /app

# Add tailscale CLI
RUN apk add --no-cache bash curl iptables ip6tables iproute2 openresolv \
   && wget -qO- https://pkgs.tailscale.com/stable/tailscale_1.66.4_amd64.tgz \
   | tar -xz -C /usr/local/bin --strip-components=1 tailscale_1.66.4_amd64/tailscale

# # Copy package.json and package-lock.json (if available)
# COPY package*.json ./

# # Install dependencies
# RUN npm install

# # Copy the rest of the application code
# COPY . .

CMD ["node", "web.js"]
