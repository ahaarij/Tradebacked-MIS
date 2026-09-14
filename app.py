from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for
import sqlite3
import os
import secrets
import functools
import threading
from datetime import datetime, timedelta
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)

_base    = os.path.dirname(__file__)
DB_PATH  = os.path.join(_base, 'dashboard.db')
SITE_DIR = os.path.join(_base, 'tb-dashboard-deploy', 'site')

# Secret key: env var or persisted file
_secret = os.environ.get('SECRET_KEY', '')
if not _secret:
    _sk_path = os.path.join(_base, '.secret_key')
    if os.path.exists(_sk_path):
        with open(_sk_path) as f:
            _secret = f.read().strip()
    if not _secret:
        _secret = secrets.token_hex(32)
        with open(_sk_path, 'w') as f:
            f.write(_secret)
app.secret_key = _secret
app.permanent_session_lifetime = timedelta(hours=12)

# Login rate limiter
_login_attempts: dict = {}
_login_lock = threading.Lock()
_MAX_ATTEMPTS = 10
_WINDOW_SECS  = 900

def _check_rate_limit(ip):
    now = datetime.now().timestamp()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < _WINDOW_SECS]
        _login_attempts[ip] = attempts
        return len(attempts) < _MAX_ATTEMPTS

def _record_failed_login(ip):
    now = datetime.now().timestamp()
    with _login_lock:
        _login_attempts.setdefault(ip, []).append(now)

def _clear_login_attempts(ip):
    with _login_lock:
        _login_attempts.pop(ip, None)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT NOT NULL,
                email         TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role          TEXT DEFAULT 'user',
                approved      INTEGER DEFAULT 0,
                created_at    TEXT DEFAULT (datetime('now'))
            )
        ''')

init_db()


def require_auth(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def require_admin(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if session.get('user_role') not in ('admin', 'superadmin'):
            return redirect(url_for('index'))
        return f(*args, **kwargs)
    return decorated


# ── Dashboard ────────────────────────────────────────────────────────────────

@app.route('/')
@require_auth
def index():
    return send_file(os.path.join(SITE_DIR, 'index.html'))

@app.route('/xlsx.full.min.js')
def xlsx_js():
    return send_file(os.path.join(SITE_DIR, 'xlsx.full.min.js'))


# ── Auth ─────────────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect('/')
    if request.method == 'POST':
        data     = request.get_json(silent=True) or {}
        email    = data.get('email', '').strip().lower()
        password = data.get('password', '')
        ip       = request.remote_addr
        if not _check_rate_limit(ip):
            return jsonify({'error': 'Too many attempts. Try again in 15 minutes.'}), 429
        with get_db() as conn:
            row = conn.execute(
                'SELECT id, name, password_hash, role, approved FROM users WHERE email=?', (email,)
            ).fetchone()
        if row and check_password_hash(row['password_hash'], password):
            if not row['approved']:
                return jsonify({'error': 'Your account is pending approval by an admin.'}), 403
            _clear_login_attempts(ip)
            session.permanent = True
            session['user_id']   = row['id']
            session['user_name'] = row['name']
            session['user_role'] = row['role']
            return jsonify({'ok': True})
        _record_failed_login(ip)
        return jsonify({'error': 'Invalid email or password.'}), 401
    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if 'user_id' in session:
        return redirect('/')
    if request.method == 'POST':
        data     = request.get_json(silent=True) or {}
        name     = data.get('name', '').strip()
        email    = data.get('email', '').strip().lower()
        password = data.get('password', '')
        if not name or not email or len(password) < 6:
            return jsonify({'error': 'All fields required; password must be at least 6 characters.'}), 400
        with get_db() as conn:
            count = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            role     = 'superadmin' if count == 0 else 'user'
            approved = 1            if count == 0 else 0
            try:
                conn.execute(
                    'INSERT INTO users (name, email, password_hash, role, approved) VALUES (?,?,?,?,?)',
                    (name, email, generate_password_hash(password), role, approved)
                )
            except sqlite3.IntegrityError:
                return jsonify({'error': 'An account with that email already exists.'}), 400
        if role == 'superadmin':
            return jsonify({'ok': True})
        return jsonify({'ok': True, 'pending': True})
    return render_template('register.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect('/login')


# ── Admin: user approval ──────────────────────────────────────────────────────

@app.route('/admin')
@require_auth
@require_admin
def admin():
    with get_db() as conn:
        users = conn.execute('SELECT id, name, email, role, approved, created_at FROM users ORDER BY created_at').fetchall()
    return render_template('admin.html', users=users, me=session['user_id'])

@app.route('/admin/approve/<int:uid>', methods=['POST'])
@require_auth
@require_admin
def approve_user(uid):
    with get_db() as conn:
        conn.execute('UPDATE users SET approved=1 WHERE id=?', (uid,))
    return jsonify({'ok': True})

@app.route('/admin/remove/<int:uid>', methods=['POST'])
@require_auth
@require_admin
def remove_user(uid):
    if uid == session['user_id']:
        return jsonify({'error': "Can't remove yourself."}), 400
    with get_db() as conn:
        conn.execute('DELETE FROM users WHERE id=?', (uid,))
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5002, debug=False)
