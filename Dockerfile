# tinyauth-mgmt image — deliberately NO docker CLI:
# the backend talks to /var/run/docker.sock over plain HTTP (backend/app.py),
# and to the Portainer API (optional) over HTTP.
FROM python:3.12-slim-bookworm

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app.py ./app.py
COPY frontend/ ./frontend/

ENV TINYAUTH_DATA_DIR=/data \
    PORT=8080
EXPOSE 8080

CMD ["gunicorn", "--workers", "2", "--bind", "0.0.0.0:8080", "--access-logfile", "-", "app:app"]
