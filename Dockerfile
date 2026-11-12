# tinyauth-mgmt image — deliberately NO docker CLI:
# the backend talks to /var/run/docker.sock over plain HTTP (backend/app.py),
# and to the Portainer API (optional) over HTTP.
#
# Multi-stage: stage1 installs dependencies into an isolated /deps tree
# (including gunicorn), stage2 copies ONLY that tree — the pip-install layer
# stays ~11MB instead of ~21MB (no install-time redundancy in the final image).
# Base: python alpine (74.8MB vs slim's188MB); deps ship official musllinux
# wheels (pyyaml/bcrypt) or are pure python (flask/gunicorn).

FROM python:3.12-alpine AS deps
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --target /deps -r /tmp/requirements.txt

FROM python:3.12-alpine
ARG APP_VERSION=dev

WORKDIR /app

COPY --from=deps /deps /app/deps
COPY backend/app.py ./app.py
COPY frontend/ ./frontend/

ENV PYTHONPATH=/app/deps \
    APP_VERSION=$APP_VERSION \
    TINYAUTH_DATA_DIR=/data \
    PORT=80
EXPOSE 80

CMD ["python3", "-m", "gunicorn", "--workers", "2", "--bind", "0.0.0.0:80", "--access-logfile", "-", "app:app"]
