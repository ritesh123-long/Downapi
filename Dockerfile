# Use slim node image
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install ffmpeg and yt-dlp
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip ca-certificates \
  && pip3 install yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json first for caching
COPY package.json package-lock.json* ./

RUN npm ci --production

# Copy app files
COPY . .

# Ensure downloads dir exists and is writable
RUN mkdir -p /app/downloads && chown -R node:node /app/downloads

USER node

EXPOSE 3000
ENV PORT=3000
CMD ["node", "index.js"]
