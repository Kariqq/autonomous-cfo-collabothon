import os
from fastapi import FastAPI
from pydantic import BaseModel
import requests

app = FastAPI(title="Autonomous CFO Agent")

MODEL_URL = os.getenv("MODEL_URL", "http://localhost:8000/v1/chat/completions")
MODEL_NAME = os.getenv("MODEL_NAME", "model")
MODEL_TOKEN = os.getenv("MODEL_TOKEN", "")

class CashflowInput(BaseModel):
    company: str
    cash_now: float
    expected_inflow_14d: float
    upcoming_bills_14d: float

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/analyze")
def analyze(data: CashflowInput):
    projected = data.cash_now + data.expected_inflow_14d - data.upcoming_bills_14d
    prompt = (
        f"Jesteś Autonomous CFO dla MŚP ({data.company}). "
        f"Aktualna gotówka: {data.cash_now}, spodziewane wpływy (14 dni): {data.expected_inflow_14d}, "
        f"zobowiązania (14 dni): {data.upcoming_bills_14d}, prognozowane saldo: {projected}. "
        f"Wskaż główne ryzyko płynności i podaj 2 krótkie działania."
    )
    headers = {"Content-Type": "application/json"}
    if MODEL_TOKEN:
        headers["Authorization"] = f"Bearer {MODEL_TOKEN}"

    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
    }
    resp = requests.post(MODEL_URL, json=payload, headers=headers, timeout=30)
    resp.raise_for_status()
    body = resp.json()
    answer = body["choices"][0]["message"]["content"]
    return {"projected_cash_14d": projected, "cfo_advice": answer}