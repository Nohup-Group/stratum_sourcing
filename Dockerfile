FROM node:22-bookworm AS node-base

FROM python:3.12-bookworm

# Copy Node.js from node image (for OpenClaw gateway wrapper)
COPY --from=node-base /usr/local/bin/node /usr/local/bin/
COPY --from=node-base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

# System deps: curl/git + Playwright's own dependency installer (covers all libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies (deps-only layer for Docker cache)
COPY pyproject.toml ./
RUN python -c "import tomllib, pathlib; d = tomllib.loads(pathlib.Path('pyproject.toml').read_text()); pathlib.Path('requirements.txt').write_text('\n'.join(d['project']['dependencies']))" \
    && pip install --no-cache-dir -r requirements.txt \
    && playwright install chromium \
    && playwright install-deps chromium

# Node dependencies (OpenClaw gateway wrapper)
COPY src/package.json src/
RUN cd src && npm install --production 2>/dev/null || true

# Copy application code
COPY . .

# Create app user and pre-create local paths. Railway volumes mount as root-owned,
# so startup must retain root privileges to initialize /data on first boot.
RUN useradd -m -s /bin/bash appuser && \
    mkdir -p /data/browser /data/cache /data/logs && \
    chown -R appuser:appuser /data /app

EXPOSE 8080 8081

CMD ["./entrypoint.sh"]
