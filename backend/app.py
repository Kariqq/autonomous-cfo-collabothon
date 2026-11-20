import os
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Autonomous CFO Agent")

MODEL_URL = os.getenv("MODEL_URL", "http://localhost:8000/v1/chat/completions")
MODEL_NAME = os.getenv("MODEL_NAME", "llama-32-3b-instruct")
MODEL_TOKEN = os.getenv("MODEL_TOKEN", "")

BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


class CashflowInput(BaseModel):
    company: str
    cash_now: float
    expected_inflow_14d: float
    upcoming_bills_14d: float


def call_llm(prompt: str) -> str:
    headers = {"Content-Type": "application/json"}
    if MODEL_TOKEN:
        headers["Authorization"] = f"Bearer {MODEL_TOKEN}"
    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": "Jesteś doświadczonym CFO dla MŚP. Odpowiadaj po polsku, zwięźle."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0.2,
    }
    try:
        resp = requests.post(MODEL_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Błąd modelu: {e}")


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze")
def analyze(data: CashflowInput):
    projected = data.cash_now + data.expected_inflow_14d - data.upcoming_bills_14d
    prompt = (
        f"Firma: {data.company}. Gotówka: {data.cash_now:.2f} PLN, "
        f"wpływy (14 dni): {data.expected_inflow_14d:.2f} PLN, "
        f"zobowiązania (14 dni): {data.upcoming_bills_14d:.2f} PLN, "
        f"prognozowane saldo: {projected:.2f} PLN. "
        "Wskaż główne ryzyko płynności i podaj 2 krótkie działania."
    )
    return {
        "projected_cash_14d": projected,
        "risk_level": "wysokie" if projected < 0 else "średnie" if projected < data.upcoming_bills_14d * 0.2 else "niskie",
        "cfo_advice": call_llm(prompt),
    }