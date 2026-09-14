FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WEFLOW_HOST=0.0.0.0 \
    WEFLOW_PORT=8080 \
    WEFLOW_DB_PATH=/data/weflow.sqlite3 \
    WEFLOW_STATIC_DIR=/app/web

RUN useradd --create-home --uid 10001 weflow

WORKDIR /app
COPY cloud/weflow_web/server.py /app/server.py
COPY electron/web-client /app/web

RUN mkdir -p /data && chown -R weflow:weflow /app /data

USER weflow
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).read()"

CMD ["python", "/app/server.py"]
