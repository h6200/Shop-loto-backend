FROM node:18-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

ENV DATABASE_PATH=/app/data/data.json

CMD ["npm", "start"]
