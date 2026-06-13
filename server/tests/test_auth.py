import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from server.app import main as app_main
from server.app.auth import (
    AuthError,
    AuthService,
    FAILED_LOGIN_LIMIT,
    FAILED_LOGIN_WINDOW_SECONDS,
    hash_password,
    session_id_from_cookie_header,
    verify_password,
)


def write_users_config(path: Path) -> None:
    salt, digest = hash_password("123456", "00112233445566778899aabbccddeeff")
    path.write_text(
        json.dumps({
            "users": [
                {
                    "email": "Chen.Lin@rbbn.com",
                    "displayName": "Chen Lin",
                    "passwordSalt": salt,
                    "passwordHash": digest,
                    "roles": ["tester"],
                }
            ]
        }),
        encoding="utf-8",
    )


class AuthServiceTest(unittest.TestCase):
    def test_password_hash_round_trip(self):
        salt, digest = hash_password("123456", "00112233445566778899aabbccddeeff")

        self.assertTrue(verify_password("123456", salt, digest))
        self.assertFalse(verify_password("wrong", salt, digest))

    def test_authenticate_accepts_case_insensitive_email_and_returns_display_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "users.json"
            write_users_config(config)
            service = AuthService(str(config))

            user = service.authenticate("  CHEN.LIN@RBBN.COM ", "123456")

            self.assertEqual(user.email, "chen.lin@rbbn.com")
            self.assertEqual(user.display_name, "Chen Lin")
            self.assertEqual(user.roles, ("tester",))

    def test_wrong_password_uses_generic_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "users.json"
            write_users_config(config)
            service = AuthService(str(config))

            with self.assertRaises(AuthError) as context:
                service.authenticate("chen.lin@rbbn.com", "wrong")

            self.assertEqual(str(context.exception), "invalid email or password")
            self.assertEqual(context.exception.status_code, 401)

    def test_failed_login_rate_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            now = 1000.0
            config = Path(temp_dir) / "users.json"
            write_users_config(config)
            service = AuthService(str(config), clock=lambda: now)

            for _ in range(FAILED_LOGIN_LIMIT):
                with self.assertRaises(AuthError):
                    service.authenticate("chen.lin@rbbn.com", "wrong")

            with self.assertRaises(AuthError) as context:
                service.authenticate("chen.lin@rbbn.com", "123456")

            self.assertEqual(context.exception.status_code, 429)

            now += FAILED_LOGIN_WINDOW_SECONDS + 1
            user = service.authenticate("chen.lin@rbbn.com", "123456")
            self.assertEqual(user.display_name, "Chen Lin")

    def test_session_expiry_and_delete(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            now = 1000.0
            config = Path(temp_dir) / "users.json"
            write_users_config(config)
            service = AuthService(str(config), clock=lambda: now)
            user = service.authenticate("chen.lin@rbbn.com", "123456")

            session_id = service.create_session(user)
            self.assertEqual(service.get_session_user(session_id), user)

            service.delete_session(session_id)
            self.assertIsNone(service.get_session_user(session_id))

            session_id = service.create_session(user)
            now += 13 * 60 * 60
            self.assertIsNone(service.get_session_user(session_id))

    def test_session_id_from_cookie_header(self):
        self.assertEqual(session_id_from_cookie_header("a=1; swr_session=abc; theme=dark"), "abc")
        self.assertIsNone(session_id_from_cookie_header("a=1"))


class AuthRouteTest(unittest.TestCase):
    def test_user_routes_require_login_and_me_returns_session_user(self):
        old_auth_service = app_main.auth_service
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "users.json"
            write_users_config(config)
            app_main.auth_service = AuthService(str(config))
            try:
                with TestClient(app_main.app) as client:
                    self.assertEqual(client.get("/api/slaves").status_code, 401)

                    login_response = client.post(
                        "/api/auth/login",
                        json={"email": "CHEN.LIN@RBBN.COM", "password": "123456"},
                    )
                    self.assertEqual(login_response.status_code, 200)
                    self.assertIn("swr_session", login_response.headers.get("set-cookie", ""))

                    me_response = client.get("/api/auth/me")
                    self.assertEqual(me_response.status_code, 200)
                    self.assertEqual(me_response.json()["displayName"], "Chen Lin")
            finally:
                app_main.auth_service = old_auth_service


if __name__ == "__main__":
    unittest.main()
