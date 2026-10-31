# make dev   → FastAPI on :8000 + Vite on :5173 (simulated mode, no keys, no GPU)
PY ?= python3
VENV := backend/.venv
BIN := $(VENV)/bin

.PHONY: dev install backend frontend test test-backend test-frontend e2e gpu docker clean

$(BIN)/uvicorn:
	$(PY) -m venv $(VENV) && $(BIN)/pip install -q -r backend/requirements-dev.txt

frontend/node_modules:
	cd frontend && npm ci

install: $(BIN)/uvicorn frontend/node_modules

dev: install
	@echo "→ http://localhost:5173  (backend http://localhost:8000)"
	@trap 'kill 0' INT TERM EXIT; \
	  (cd backend && ../$(BIN)/uvicorn app.main:app --reload --port 8000) & \
	  (cd frontend && npx vite --port 5173) & \
	  wait

gpu: $(BIN)/uvicorn
	$(BIN)/pip install -r backend/requirements-gpu.txt

test: test-backend test-frontend e2e

test-backend: $(BIN)/uvicorn
	cd backend && ../$(BIN)/python -m pytest -q

test-frontend: frontend/node_modules
	cd frontend && npx tsc --noEmit -p . && npx vitest run

e2e: install
	cd frontend && npx playwright install chromium && PYTHON=../$(BIN)/python npx playwright test

docker:
	docker compose up --build

clean:
	rm -rf $(VENV) frontend/node_modules frontend/dist frontend/dist-e2e
