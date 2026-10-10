# Build the React app, then serve it (and proxy the API) with Caddy.
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Same origin as the API, so no VITE_API_URL is needed.
RUN NODE_ENV=production npm run build

FROM caddy:2.8-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
