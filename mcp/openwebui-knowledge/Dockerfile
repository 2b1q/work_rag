FROM node:24-alpine AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm ci --silent || npm i --silent

COPY src ./src
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist

EXPOSE 8787
CMD ["node", "dist/index.js"]