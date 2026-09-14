# VYNE API — Cloud Run container
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Migrations ship with the image so the one-shot migrate job can run them.
COPY src/db/migrations ./dist/db/migrations
EXPOSE 8080
CMD ["node", "dist/index.js"]
