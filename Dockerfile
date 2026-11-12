# tinyauth-mgmt image — deliberately NO docker CLI:
# the backend talks to /var/run/docker.sock over plain HTTP (backend/app.py),
# and to the Portainer API (optional) over HTTP.
FROM python:3.12-slim-bookworm

ARG APP_VERSION=dev

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app.py ./app.py
COPY frontend/ ./frontend/

ENV APP_VERSION=$APP_VERSION \
    TINYAUTH_DATA_DIR=/data \
    PORT=80
EXPOSE 80

CMD ["gunicorn", "--workers", "2", "--bind", "0.0.0.0:80", "--access-logfile", "-", "app:app"]
