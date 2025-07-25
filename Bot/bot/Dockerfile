FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY bot.js ./

CMD ["node", "bot.js"]
