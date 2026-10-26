FROM node:20-bookworm-slim

WORKDIR /workspace

RUN npm install -g opencode-ai@latest || npm install -g opencode@latest
RUN mkdir -p /runtime /root/.local/share/opencode

ENV OPENCODE_HOSTNAME=0.0.0.0
ENV OPENCODE_PORT=4096

EXPOSE 4096
CMD ["sh", "-c", "opencode serve --hostname ${OPENCODE_HOSTNAME:-0.0.0.0} --port ${OPENCODE_PORT:-4096}"]
