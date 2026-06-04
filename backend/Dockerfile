FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 8080
RUN mkdir -p /data
CMD ["npm", "start"]
