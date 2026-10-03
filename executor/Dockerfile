FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git python3 build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=alpha
RUN npm install -g @openai/codex@${CODEX_VERSION}
WORKDIR /workspace
ENTRYPOINT ["codex", "exec-server"]
