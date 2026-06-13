from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Callable


DEFAULT_USERS_CONFIG = "server/config/users.json"
DEFAULT_SESSION_COOKIE = "swr_session"
DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60
PBKDF2_ITERATIONS = 120_000
FAILED_LOGIN_WINDOW_SECONDS = 60
FAILED_LOGIN_LIMIT = 5


def normalize_email(value: str) -> str:
    return value.strip().lower()


def hash_password(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    ).hex()
    return salt.hex(), digest


def verify_password(password: str, salt_hex: str, expected_hash: str) -> bool:
    _salt, digest = hash_password(password, salt_hex)
    return hmac.compare_digest(digest, expected_hash)


def cookie_secure_enabled() -> bool:
    return os.environ.get("SWR_COOKIE_SECURE", "false").strip().lower() in {"1", "true", "yes", "on"}


def session_cookie_name() -> str:
    return os.environ.get("SWR_SESSION_COOKIE", DEFAULT_SESSION_COOKIE)


def session_ttl_seconds() -> int:
    raw_value = os.environ.get("SWR_SESSION_TTL_SECONDS", str(DEFAULT_SESSION_TTL_SECONDS))
    try:
        return max(60, int(raw_value))
    except ValueError:
        return DEFAULT_SESSION_TTL_SECONDS


@dataclass(frozen=True)
class AuthenticatedUser:
    email: str
    display_name: str
    roles: tuple[str, ...] = ("tester",)


@dataclass(frozen=True)
class UserRecord:
    email: str
    display_name: str
    password_salt: str
    password_hash: str
    roles: tuple[str, ...]


@dataclass
class SessionRecord:
    user: AuthenticatedUser
    expires_at: float


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.status_code = status_code


class AuthService:
    def __init__(
        self,
        users_config: str | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._clock = clock or time.time
        self._sessions: dict[str, SessionRecord] = {}
        self._failed_logins: dict[str, list[float]] = {}
        self._users = self._load_users(users_config)

    def _load_users(self, users_config: str | None = None) -> dict[str, UserRecord]:
        config_path = Path(users_config or os.environ.get("SWR_USERS_CONFIG", DEFAULT_USERS_CONFIG))
        if not config_path.exists():
            return {}
        data = json.loads(config_path.read_text(encoding="utf-8"))
        users: dict[str, UserRecord] = {}
        for item in data.get("users", []):
            email = normalize_email(str(item.get("email", "")))
            display_name = str(item.get("displayName", "")).strip()
            password_salt = str(item.get("passwordSalt", "")).strip()
            password_hash = str(item.get("passwordHash", "")).strip()
            roles = tuple(str(role) for role in item.get("roles", ["tester"]))
            if not email or not display_name or not password_salt or not password_hash:
                raise RuntimeError(f"invalid user config entry in {config_path}")
            users[email] = UserRecord(
                email=email,
                display_name=display_name,
                password_salt=password_salt,
                password_hash=password_hash,
                roles=roles,
            )
        return users

    def authenticate(self, email: str, password: str) -> AuthenticatedUser:
        normalized_email = normalize_email(email)
        self._ensure_not_limited(normalized_email)
        user = self._users.get(normalized_email)
        if user and verify_password(password, user.password_salt, user.password_hash):
            self._failed_logins.pop(normalized_email, None)
            return AuthenticatedUser(
                email=user.email,
                display_name=user.display_name,
                roles=user.roles,
            )
        self._record_failed_login(normalized_email)
        raise AuthError("invalid email or password")

    def create_session(self, user: AuthenticatedUser) -> str:
        session_id = secrets.token_urlsafe(32)
        self._sessions[session_id] = SessionRecord(
            user=user,
            expires_at=self._clock() + session_ttl_seconds(),
        )
        return session_id

    def get_session_user(self, session_id: str | None) -> AuthenticatedUser | None:
        if not session_id:
            return None
        record = self._sessions.get(session_id)
        if not record:
            return None
        if record.expires_at <= self._clock():
            self._sessions.pop(session_id, None)
            return None
        return record.user

    def delete_session(self, session_id: str | None) -> None:
        if session_id:
            self._sessions.pop(session_id, None)

    def session_count(self) -> int:
        self._sweep_sessions()
        return len(self._sessions)

    def _sweep_sessions(self) -> None:
        now = self._clock()
        expired = [session_id for session_id, record in self._sessions.items() if record.expires_at <= now]
        for session_id in expired:
            self._sessions.pop(session_id, None)

    def _ensure_not_limited(self, normalized_email: str) -> None:
        now = self._clock()
        attempts = [
            timestamp for timestamp in self._failed_logins.get(normalized_email, [])
            if now - timestamp <= FAILED_LOGIN_WINDOW_SECONDS
        ]
        self._failed_logins[normalized_email] = attempts
        if len(attempts) >= FAILED_LOGIN_LIMIT:
            raise AuthError("too many login attempts", status_code=429)

    def _record_failed_login(self, normalized_email: str) -> None:
        attempts = self._failed_logins.setdefault(normalized_email, [])
        attempts.append(self._clock())


def session_id_from_cookie_header(cookie_header: str | None, cookie_name: str | None = None) -> str | None:
    if not cookie_header:
        return None
    cookie = SimpleCookie()
    cookie.load(cookie_header)
    morsel = cookie.get(cookie_name or session_cookie_name())
    return morsel.value if morsel else None
