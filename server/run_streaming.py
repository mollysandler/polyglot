#!/usr/bin/env python3
"""Run the streaming translation server locally (no Modal, no GPU)."""

import logging

import uvicorn
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware

from streaming_server import app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

load_dotenv()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)
