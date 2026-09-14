@echo off
cd "C:\TBDashboard\repo"
python -m flask --app app run --host=127.0.0.1 --port=5002
