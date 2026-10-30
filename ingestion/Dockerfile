FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY twin_ingestion ./twin_ingestion
CMD ["python", "-m", "twin_ingestion.main"]

