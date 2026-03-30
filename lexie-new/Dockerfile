FROM node:22-bookworm

ARG OPENCLAW_VERSION=2026.3.28
ARG GOG_VERSION=0.12.0

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=8080 \
    INTERNAL_GATEWAY_HOST=127.0.0.1 \
    INTERNAL_GATEWAY_PORT=18789 \
    OPENCLAW_HOME=/data \
    OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    XDG_CONFIG_HOME=/data/.config \
    XDG_DATA_HOME=/data/.local/share \
    XDG_CACHE_HOME=/data/.cache \
    CHROME_BIN=/usr/bin/chromium \
    CHROMIUM_BIN=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    dbus \
    dbus-x11 \
    fonts-liberation \
    gnome-keyring \
    jq \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libsecret-1-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    procps \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openclaw@${OPENCLAW_VERSION}" \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) gog_arch="amd64" ;; \
        arm64) gog_arch="arm64" ;; \
        *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
      esac \
    && asset="gogcli_${GOG_VERSION}_linux_${gog_arch}.tar.gz" \
    && curl -fsSL -o "/tmp/${asset}" "https://github.com/steipete/gogcli/releases/download/v${GOG_VERSION}/${asset}" \
    && curl -fsSL -o /tmp/checksums.txt "https://github.com/steipete/gogcli/releases/download/v${GOG_VERSION}/checksums.txt" \
    && (cd /tmp && grep " ${asset}\$" checksums.txt | sha256sum -c -) \
    && tar -xzf "/tmp/${asset}" -C /usr/local/bin gog \
    && chmod +x /usr/local/bin/gog \
    && rm -f "/tmp/${asset}" /tmp/checksums.txt

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ops-gateway.js session-store.js auth.js request-auth.js pg-config.js entrypoint.sh README.md railway.toml ./
COPY scripts/ /app/scripts/
COPY workspace/ /app/workspace/
COPY workspace-investor/ /app/workspace-investor/

RUN mkdir -p /app /data \
    && chmod +x /app/entrypoint.sh \
    && find /app/scripts -type f -name '*.js' -exec chmod 0644 {} \; \
    && ln -s /usr/local/lib/node_modules/openclaw /openclaw

EXPOSE 8080 18789

CMD ["./entrypoint.sh"]
