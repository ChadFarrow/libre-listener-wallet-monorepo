# TCP→WebSocket bridge so a browser LDK node can reach a Lightning peer.
# Browsers can't open raw TCP; this proxies a (wss, via Railway TLS) WebSocket to the
# peer's TCP :9735. Target defaults to the clearnet Tor-proxy that fronts the onion LND.
FROM python:3-slim
RUN pip install --no-cache-dir websockify
# Override in Railway if the peer/proxy changes. Format: host:port
ENV BRIDGE_TARGET=45.33.65.45:9735
# Railway injects PORT and terminates TLS in front of us (public endpoint is wss://).
CMD ["sh", "-c", "websockify 0.0.0.0:${PORT:-8080} ${BRIDGE_TARGET}"]
