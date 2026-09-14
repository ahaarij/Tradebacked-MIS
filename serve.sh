#!/bin/bash
# Run the dashboard locally at http://localhost:5002
cd "$(dirname "$0")"
python3 -m flask --app app run --host=127.0.0.1 --port=5002
