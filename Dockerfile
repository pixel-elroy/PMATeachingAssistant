FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend, context.md and the static/ frontend folder
COPY . .

EXPOSE 8000

CMD ["uvicorn", "CSPML_LAB_05_EE26MT005:app", "--host", "0.0.0.0", "--port", "8000"]
