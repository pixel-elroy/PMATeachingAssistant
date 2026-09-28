FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend, frontend files, and context.md
COPY . .

EXPOSE 8000

# Notice the updated filename here:
CMD ["uvicorn", "CSPML_LAB_05_EE26MT005:app", "--host", "0.0.0.0", "--port", "8000"]
