FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js .

RUN mkdir -p /app/data

CMD ["node", "index.js"]
