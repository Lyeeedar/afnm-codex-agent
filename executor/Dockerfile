FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=alpha
RUN npm install -g @openai/codex@${CODEX_VERSION} playwright@1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENTRYPOINT ["codex", "exec-server"]
