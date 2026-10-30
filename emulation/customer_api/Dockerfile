FROM python:3.13-slim
RUN pip install --no-cache-dir asyncpg==0.30.0
COPY emulation/customer_api/app.py /app/customer_app.py
ENTRYPOINT ["sleep", "infinity"]
