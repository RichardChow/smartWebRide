import os
import unittest
from unittest.mock import patch

from agent.swr_agent.pty_service import PtyService, PtySession, TerminalAnsiHighlighter


# Exact dige-black scope colors (24-bit truecolor SGR), used for assertions.
ERROR = "\x1b[38;2;244;71;71m"
SUCCESS = "\x1b[38;2;50;205;50m"
WARN = "\x1b[38;2;205;151;49m"
INFO = "\x1b[38;2;103;150;230m"
DEBUG = "\x1b[38;2;178;103;230m"
HEADING = "\x1b[38;2;166;226;46m"
NUMERIC = "\x1b[38;2;174;129;255m"
OPTION = "\x1b[38;2;253;151;31m"
STRING = "\x1b[38;2;230;219;116m"
DIFF = "\x1b[38;2;117;113;94m"
RESET = "\x1b[0m"


class PtySessionShapeTest(unittest.TestCase):
    def test_session_can_record_real_pty_master_fd(self):
        session = PtySession(id="s", process=None, reader_task=None, master_fd=3)  # type: ignore[arg-type]
        self.assertEqual(session.master_fd, 3)

    def test_windows_fallback_can_record_pipe_session(self):
        session = PtySession(id="s", process=None, reader_task=None, master_fd=None)  # type: ignore[arg-type]
        self.assertIsNone(session.master_fd)
        self.assertIn(os.name, {"nt", "posix"})

    def test_terminal_env_forces_color_capabilities(self):
        async def _noop(_session_id: str, _data: str) -> None:
            return None

        service = PtyService(_noop)
        with patch.dict(os.environ, {"TERM": "dumb"}, clear=False):
            env = service._build_env()

        self.assertEqual(env["TERM"], "xterm-256color")
        self.assertEqual(env["COLORTERM"], "truecolor")
        self.assertEqual(env["CLICOLOR"], "1")

    @unittest.skipIf(os.name == "nt", "bash bootstrap is only used for Linux PTY sessions")
    def test_bash_command_uses_smartwebride_rcfile(self):
        async def _noop(_session_id: str, _data: str) -> None:
            return None

        service = PtyService(_noop)
        command = service._build_command("/bin/bash", ["/bin/bash", "--login", "-i"])

        self.assertEqual(command[0], "/bin/bash")
        self.assertEqual(command[1], "--rcfile")
        self.assertEqual(command[3], "-i")

        rc_text = open(command[2], encoding="utf-8").read()
        self.assertIn("SWR_PROFILE_BOOTSTRAPPED", rc_text)
        self.assertIn("TERM=xterm-256color", rc_text)
        self.assertNotIn("ls() {", rc_text)


class TerminalAnsiHighlighterTest(unittest.TestCase):
    """Asserts parity with WindTerm 2.7.0 linux scheme (dige-black exact truecolor)."""

    def setUp(self):
        self.highlighter = TerminalAnsiHighlighter()

    def test_keyword_classes_use_windterm_token_colors(self):
        result = self.highlighter.feed("error true sudo login\n")

        self.assertIn(f"{ERROR}error{RESET}", result)
        self.assertIn(f"{SUCCESS}true{RESET}", result)
        self.assertIn(f"{WARN}sudo{RESET}", result)
        self.assertIn(f"{INFO}login{RESET}", result)

    def test_permission_bits_colored_per_character(self):
        result = self.highlighter.feed(" drwxr-xr-x root\n")

        self.assertIn(f"{DEBUG}d{RESET}", result)
        self.assertIn(f"{INFO}r{RESET}", result)
        self.assertIn(f"{WARN}w{RESET}", result)
        self.assertIn(f"{ERROR}x{RESET}", result)
        self.assertIn(f"{HEADING}-{RESET}", result)

    def test_ip_and_mac_use_heading_color(self):
        result = self.highlighter.feed("addr 192.0.2.10 hw aa:bb:cc:dd:ee:ff\n")

        self.assertIn(f"{HEADING}192.0.2.10{RESET}", result)
        self.assertIn(f"{HEADING}aa:bb:cc:dd:ee:ff{RESET}", result)

    def test_option_flag_equals_and_value(self):
        result = self.highlighter.feed("gcc --std=c11 -O2\n")

        self.assertIn(f"{OPTION}--std{RESET}{DIFF}={RESET}{INFO}c11{RESET}", result)
        self.assertIn(f"{OPTION}-O2{RESET}", result)

    def test_numbers_and_hex_use_numeric_color(self):
        result = self.highlighter.feed("size 4096 ratio 7.5 word dead\n")

        self.assertIn(f"{NUMERIC}4096{RESET}", result)
        self.assertIn(f"{NUMERIC}7.5{RESET}", result)
        # 4-letter hex run after whitespace is numeric, mirroring WindTerm's number rule
        self.assertIn(f"{NUMERIC}dead{RESET}", result)

    def test_datetime_and_string_and_operator(self):
        result = self.highlighter.feed('when 2026-06-02 May say "hi" v = 3\n')

        self.assertIn(f"{HEADING}2026-06-02{RESET}", result)
        self.assertIn(f"{HEADING}May{RESET}", result)
        self.assertIn(f'{STRING}"hi"{RESET}', result)
        self.assertIn(f"{HEADING}={RESET}", result)

    def test_keeps_existing_control_output_raw(self):
        sample = "\x1b[2J\x1b[Htop screen\n"

        self.assertEqual(self.highlighter.feed(sample), sample)

    def test_keeps_shell_command_echo_raw(self):
        sample = "ps -ef | head -5; printf 'ERROR 85% /tmp/swr-debug\\n'\n"

        self.assertEqual(self.highlighter.feed(sample), sample)


if __name__ == "__main__":
    unittest.main()
