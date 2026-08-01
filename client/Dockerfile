FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
# postinstall copies VAD assets into public/ and needs the package files present
COPY public ./public
RUN npm ci
COPY . .
# NEXT_PUBLIC_* is baked into the bundle at build time
ARG NEXT_PUBLIC_RELAY_WS=wss://voizecode-relay.fly.dev
ENV NEXT_PUBLIC_RELAY_WS=$NEXT_PUBLIC_RELAY_WS
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3030
CMD ["npm", "start"]
