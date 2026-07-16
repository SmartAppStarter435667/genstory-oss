# langchain/Dockerfile — FastAPIオーケストレーター用
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY story_chain.py orchestrator.py ./

EXPOSE 8000

CMD ["uvicorn", "orchestrator:app", "--host", "0.0.0.0", "--port", "8000"]
