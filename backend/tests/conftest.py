import os

os.environ.setdefault("LIVE_SIM_STEP_MS", "5")
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("FAL_KEY", None)
