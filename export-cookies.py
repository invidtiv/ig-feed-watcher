#!/usr/bin/env python3
"""
IG Cookie Exporter — Extract Instagram cookies from a local Chrome profile.

Usage:
  python3 export-cookies.py [--profile-dir PATH]

This reads the SQLite cookies database from your Chrome/Chromium profile,
decrypts the cookie values (using Chrome's key from the OS keyring),
and writes them to cookies.json in Puppeteer format.

On a headless server, you can:
  1. Copy your Chrome profile's Cookies database here, then run this script
  2. Or manually export from DevTools → Application → Cookies → instagram.com

For manual export, create cookies.json with this format:
[
  {
    "name": "sessionid",
    "value": "PASTE_VALUE_HERE",
    "domain": ".instagram.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax"
  },
  ... more cookies ...
]

The critical cookies for Instagram auth are:
  - sessionid (the main session token)
  - ds_user_id (your user ID)
  - csrftoken (CSRF token)
  - mid, ig_did, rur (device/region cookies)

You can get these from browser DevTools:
  1. Open instagram.com in your browser
  2. F12 → Application tab → Cookies → https://www.instagram.com
  3. Copy each cookie's name/value into cookies.json
"""

import json
import os
import sys
import argparse
import sqlite3
import shutil
import tempfile
from pathlib import Path

# Chrome cookie decryption
try:
    from Crypto.Cipher import AES
    from Crypto.Protocol.KDF import PBKDF2
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

# Linux: Chrome uses PBKDF2 with "peanuts" password
# macOS: Chrome uses Keychain
# Windows: Chrome uses DPAPI

def get_linux_chrome_key():
    """Get Chrome's cookie decryption key on Linux."""
    # Chrome on Linux uses a hardcoded password "peanuts"
    password = b'peanuts'
    salt = b'saltysalt'
    key = PBKDF2(password, salt, dkLen=16, count=1)
    return key

def decrypt_cookie_value(encrypted_value, key):
    """Decrypt a Chrome cookie value."""
    if not encrypted_value:
        return ''

    # Chrome v10+ format: starts with 'v10' or 'v11'
    if encrypted_value[:3] == b'v10' or encrypted_value[:3] == b'v11':
        iv = b' ' * 16  # 16 spaces
        encrypted_data = encrypted_value[3:]
        try:
            cipher = AES.new(key, AES.MODE_CBC, iv)
            decrypted = cipher.decrypt(encrypted_data)
            # Remove PKCS7 padding
            pad_len = decrypted[-1]
            if isinstance(pad_len, int) and 1 <= pad_len <= 16:
                decrypted = decrypted[:-pad_len]
            return decrypted.decode('utf-8', errors='replace')
        except Exception as e:
            print(f"Decrypt error: {e}")
            return ''

    # Not encrypted (older Chrome or some cookies)
    try:
        return encrypted_value.decode('utf-8')
    except:
        return ''

def export_cookies_from_chrome(cookies_db_path, output_path):
    """Export Instagram cookies from Chrome's SQLite database."""
    if not HAS_CRYPTO:
        print("WARNING: pycryptodome not installed. Cannot decrypt Chrome cookies.")
        print("Install with: pip install pycryptodome")
        print("Or manually export cookies from DevTools (see script header).")
        return False

    if not os.path.exists(cookies_db_path):
        print(f"ERROR: Cookies database not found: {cookies_db_path}")
        return False

    # Copy the DB to temp (Chrome locks the original)
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        shutil.copy2(cookies_db_path, tmp.name)
        tmp_path = tmp.name

    try:
        key = get_linux_chrome_key()
        conn = sqlite3.connect(tmp_path)
        cursor = conn.cursor()

        # Query for instagram.com cookies
        cursor.execute("""
            SELECT name, encrypted_value, host_key, path, expires_utc,
                   is_secure, is_httponly, samesite
            FROM cookies
            WHERE host_key LIKE '%instagram.com%'
            ORDER BY name
        """)

        rows = cursor.fetchall()
        if not rows:
            print("No Instagram cookies found in the database.")
            print("Make sure you've logged into Instagram in this Chrome profile.")
            return False

        # sameSite mapping: Chrome uses 0=none, 1=lax, 2=strict
        samesite_map = {0: 'None', 1: 'Lax', 2: 'Strict'}

        cookies = []
        for name, enc_value, host, path, expires_utc, secure, httponly, samesite in rows:
            value = decrypt_cookie_value(enc_value, key)
            cookies.append({
                'name': name,
                'value': value,
                'domain': host,
                'path': path or '/',
                'expires': expires_utc if expires_utc else -1,
                'httpOnly': bool(httponly),
                'secure': bool(secure),
                'sameSite': samesite_map.get(samesite, 'Lax'),
            })

        with open(output_path, 'w') as f:
            json.dump(cookies, f, indent=2)

        print(f"Exported {len(cookies)} cookies to {output_path}")
        print("\nCookie names:")
        for c in cookies:
            print(f"  {c['name']} ({c['domain']})")

        # Check for critical auth cookies
        critical = ['sessionid', 'ds_user_id', 'csrftoken']
        have = [c['name'] for c in cookies]
        missing = [n for n in critical if n not in have]
        if missing:
            print(f"\nWARNING: Missing critical cookies: {', '.join(missing)}")
            print("Your Instagram session may not work without these.")
        else:
            print("\nAll critical auth cookies present.")

        conn.close()
        return True

    finally:
        os.unlink(tmp_path)

def main():
    parser = argparse.ArgumentParser(description='Export Instagram cookies from Chrome profile')
    parser.add_argument('--profile-dir', default=None,
                        help='Path to Chrome profile directory (default: auto-detect)')
    parser.add_argument('--output', default='cookies.json',
                        help='Output file path (default: cookies.json)')
    args = parser.parse_args()

    # Auto-detect Chrome profile
    profile_dir = args.profile_dir
    if not profile_dir:
        candidates = [
            os.path.expanduser('~/.config/google-chrome/Default'),
            os.path.expanduser('~/.config/chromium/Default'),
            os.path.expanduser('~/.config/google-chrome/Profile 1'),
        ]
        for c in candidates:
            if os.path.isdir(c):
                profile_dir = c
                break

    if not profile_dir:
        print("ERROR: Could not find Chrome profile directory.")
        print("Please specify with --profile-dir PATH")
        return 1

    cookies_db = os.path.join(profile_dir, 'Cookies')
    print(f"Reading cookies from: {cookies_db}")

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.output)
    success = export_cookies_from_chrome(cookies_db, output_path)
    return 0 if success else 1

if __name__ == '__main__':
    sys.exit(main())
