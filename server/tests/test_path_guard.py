import unittest

from fastapi import HTTPException

from server.app.path_guard import ensure_allowed_path


class PathGuardTest(unittest.TestCase):
    def test_allows_path_under_root(self):
        path = ensure_allowed_path(".", ["."])
        self.assertTrue(path.exists())

    def test_rejects_path_outside_root(self):
        with self.assertRaises(HTTPException):
            ensure_allowed_path("..", ["./src"])


if __name__ == "__main__":
    unittest.main()

