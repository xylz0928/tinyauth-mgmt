# tinyauth-mgmt image — option B: source-built, pip-free CPython.
# three stages:
#   deps    — pip --target /deps (isolated, ~11.6MB copied forward)
#   pybuild — compile CPython from python.org tarball (sha256-pinned),
#             WITHOUT pip/ensurepip, test-modules disabled, static libs and
#             idle/tk/test trees stripped after install
#   runtime — bare alpine + runtime .so libs + /opt/python + /deps
# Result: ~68MB (vs89.4MB option A /214MB original). No pip in the final
# image at all; daily code updates still hit the stage caches (single
# `docker build` — the compile only reruns when PYTHON_VERSION/base change).

FROM python:3.12-alpine AS deps
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --target /deps -r /tmp/requirements.txt

# sourceless stdlib technique: compile legacy pycs next to the .py sources,
# then drop the .py — imports resolve from the legacy pyc (PEP3147 fallback),
# saving the duplicated source+bytecode trees at runtime.
FROM alpine:3.22 AS pybuild
ARG PYTHON_VERSION=3.12.16
ARG PYTHON_SHA256=710c3e75dac8b2f258d9cd0f76e5c4c2e9175fac9e249c98901552f7cf33b7dd
RUN apk add --no-cache build-base make zlib-dev openssl-dev readline-dev \
    sqlite-dev libffi-dev bzip2-dev xz-dev ncurses-dev util-linux-dev \
    linux-headers
RUN wget -q "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz" -O /Python.tgz \
    && echo "${PYTHON_SHA256}  /Python.tgz" | sha256sum -c - \
    && mkdir /src \
    && tar -xzf /Python.tgz -C /src --strip-components=1 \
    && cd /src \
    && ./configure --prefix=/opt/python \
        --without-ensurepip \
        --disable-test-modules \
        --with-openssl=/usr \
    && make -j"$(nproc)" \
    && make install \
    && rm -rf \
        /opt/python/lib/python3.12/config-3.12-* \
        /opt/python/lib/libpython3.12*.a \
        /opt/python/lib/python3.12/test \
        /opt/python/lib/python3.12/idlelib \
        /opt/python/lib/python3.12/tkinter \
        /opt/python/lib/python3.12/lib2to3 \
        /opt/python/bin/python3.12-config \
        /opt/python/share/man \
        /opt/python/lib/python3.12/turtledemo \
        /opt/python/lib/python3.12/ensurepip \
    && rm -f /opt/python/bin/python3-config /opt/python/bin/idle3* \
        /opt/python/bin/pydoc3* /opt/python/bin/2to3* \
    && strip --strip-unneeded /opt/python/bin/python3.12 \
    && find /opt/python/lib/python3.12/lib-dynload -name '*.so' -print0 \
        | xargs -0 -r strip --strip-unneeded \
    && rm -rf /opt/python/include \
    && rm -f /opt/python/lib/python3.12/lib-dynload/_tkinter*.so \
    && /opt/python/bin/python3 -V \
    && /opt/python/bin/python3 -m compileall -b -f -q /opt/python/lib/python3.12 \
    && find /opt/python/lib/python3.12 -name '*.py' -print0 \
        | xargs -0 -r rm -f \
    && find /opt/python/lib/python3.12 -name '__pycache__' -print0 \
        | xargs -0 -r rm -rf \
    && /opt/python/bin/python3 -c "import ssl, sqlite3, zlib, hmac, json, \
        http.server, email, asyncio, uuid, unicodedata; print('stdlib sourceless OK')"

FROM alpine:3.22
ARG APP_VERSION=dev

# runtime shared objects the stripped CPython still links against
RUN apk add --no-cache libssl3 zlib sqlite-libs libffi libuuid readline ncurses-libs

WORKDIR /app

ENV PATH="/opt/python/bin:$PATH" \
    PYTHONPATH=/app/deps \
    APP_VERSION=$APP_VERSION \
    TINYAUTH_DATA_DIR=/data \
    PORT=80
EXPOSE 80

COPY --from=pybuild /opt/python /opt/python
COPY --from=deps /deps /app/deps
# sourceless deps (same technique) + build-time import self-check
RUN python3 -m compileall -b -f -q /app/deps \
    && find /app/deps -name '*.py' -print0 | xargs -0 -r rm -f \
    && find /app/deps -name '__pycache__' -print0 | xargs -0 -r rm -rf \
    && python3 -c "import flask, gunicorn, yaml, bcrypt; print('deps import OK')"
COPY backend/app.py ./app.py
COPY frontend/ ./frontend/


CMD ["python3", "-m", "gunicorn", "--workers", "2", "--bind", "0.0.0.0:80", "--access-logfile", "-", "app:app"]
