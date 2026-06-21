FROM oven/bun:1 AS base
WORKDIR /app

# Install Python for Camoufox browser automation
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Setup Python venv
RUN python3 -m venv scripts/auth/.venv && \
    scripts/auth/.venv/bin/pip install -r scripts/auth/requirements.txt

# Build dashboard
WORKDIR /app/dashboard
RUN bun install && bun run build
WORKDIR /app

# Run migration on startup then serve
EXPOSE 1930
CMD ["sh", "-c", "bun src/db/migrate.ts && bun src/index.ts"]
