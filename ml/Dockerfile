FROM python:3.12-slim

WORKDIR /work/ml
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "pipeline.run"]
