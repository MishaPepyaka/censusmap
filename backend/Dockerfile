FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

EXPOSE 8080
RUN mkdir -p /data
CMD ["npm", "start"]
