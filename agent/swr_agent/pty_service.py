from __future__ import annotations

import asyncio
import os
import re
import signal
import shlex
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

if os.name != "nt":
    import fcntl
    import termios


OutputCallback = Callable[[str, str], Awaitable[None]]
CwdCallback = Callable[[str, str], Awaitable[None]]


BASH_RC_TEMPLATE = r'''# smartWebRide interactive terminal bootstrap.
export TERM="${TERM:-xterm-256color}"
export COLORTERM="${COLORTERM:-truecolor}"
export CLICOLOR="${CLICOLOR:-1}"

if [ -z "${SWR_PROFILE_BOOTSTRAPPED:-}" ]; then
  export SWR_PROFILE_BOOTSTRAPPED=1
  [ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1 || true
  for swr_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -r "$swr_profile" ] && . "$swr_profile" >/dev/null 2>&1 && break
  done
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1 || true
fi

export TERM=xterm-256color
export COLORTERM=truecolor
export CLICOLOR=1
'''


ANSI_RESET = "\033[0m"
ANSI_OR_CONTROL_RE = re.compile(r"(\x1b|\x9b|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f])")


def _rgb(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    return f"38;2;{int(h[0:2], 16)};{int(h[2:4], 16)};{int(h[4:6], 16)}"


# dige-black scope -> exact RGB (from WindTerm 2.7.0 global/themes/dige-black/scheme.theme,
# applied to terminal/schemes/linux/linux.lexer token scopes). Emitted as 24-bit truecolor.
C_ERROR = _rgb("#f44747")     # token.error-token
C_SUCCESS = _rgb("#32CD32")   # token.success-token (limegreen)
C_WARN = _rgb("#cd9731")      # token.warn-token
C_INFO = _rgb("#6796e6")      # token.info-token
C_DEBUG = _rgb("#b267e6")     # token.debug-token
C_HEADING = _rgb("#A6E22E")   # markup.heading (ip/mac/datetime)
C_NUMERIC = _rgb("#AE81FF")   # constant.numeric
C_OPTION = _rgb("#FD971F")    # variable.language
C_STRING = _rgb("#E6DB74")    # string
C_PUNCT = _rgb("#A6E22E")     # punctuation.definition.delimiter/block
C_DIFF = _rgb("#75715E")      # meta.diff (option '=')

_OPERATOR_CHARS = set("=:;|?*$<>&+-()[]{}")

# Keyword word lists (ported verbatim from linux.lexer "keyword" repository, possessive
# quantifiers relaxed to greedy for stdlib re). Each colored by its WindTerm token scope.
_KW_ERROR = (
    r"(?i:\b(?:bad|cannot(?: \w+)?|denied|deprecated|disabled|errors?|fail(?:ed)?|failure"
    r"|false|important|incorrect|invalid|no(?: \w+)?|none"
    r"|(?:(?:do|does|can|will|could|should|would) )?not(?: \w+)?"
    r"|(?:do|does|ca|wo|could|should|would)n't(?:(?: be)? \w+)?"
    r"|refused|unknown|unsupported|warn(?:ing)?|wrong)\b)"
)
_KW_OK = (
    r"(?i:\b(?:can(?: \w+)?|correct(?:ly)?|known|ok|pass(?:ed)?|success(?:ful(?:ly)?)?"
    r"|supported|true|yes|valid)\b)"
)
_KW_WARN = r"(?i:\b(?:closed|exited|debug|disconnected|skipped|stopped|sudo|terminated)\b)"
_KW_INFO = (
    r"(?i:\b(?:access|any|authentication|connection|disconnection|info|login|operation"
    r"|password|permission)\b)"
)

# permissions region: [type][rwx]{9}[.+]?, preceded by whitespace and followed by a space.
_PERM = r"(?<=\s)(?P<perm>[bcCdDlMnpPs?-](?:[rw-]{2}[xsStT-]){3}[.+]?)(?= )"

# option: after whitespace / '[' / '|', a -x or --long flag with optional =value.
_OPTION = r"(?P<option>(?<=[\s\[|])--?\w[-\w]*(?:=\w+)?)"

# operators and brackets (single char).
_OPERATOR = r"(?P<operator>[=:;|?*$<>&+()\[\]{}\-])"

# single-line quoted string.
_STRING = r"(?P<string>'[^'\n]*'|\"[^\"\n]*\")"

# ip: IPv4 plus common IPv6 forms (linux.lexer used \g<X> subroutines; expanded for stdlib re).
_IPV4 = r"(?:(?:[01]?\d\d?|2[0-4]\d|25[0-5])\.){3}(?:[01]?\d\d?|2[0-4]\d|25[0-5])"
_IPV6 = (
    r"(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,7}:"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}"
    r"|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}"
    r"|[A-Fa-f0-9]{1,4}:(?::[A-Fa-f0-9]{1,4}){1,6}"
    r"|::(?:[A-Fa-f0-9]{1,4}:){0,6}[A-Fa-f0-9]{1,4}"
)
_IP = r"(?P<ip>(?<![\w.:])(?:" + _IPV4 + r"|" + _IPV6 + r")(?![\w.:]))"

_MAC = r"(?P<mac>(?<![\w:-])(?:[A-Fa-f0-9]{2}[:-]){5}[A-Fa-f0-9]{2}(?![\w:-]))"

# datetime: dates / iso / times / months / weekdays (ported from linux.lexer "datetime").
_DATETIME = (
    r"(?P<datetime>"
    r"\b\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?Z?(?: GMT)?)?\b"
    r"|\b\d{1,2}[/-]\d{1,2}[/-]\d{2}(?:\d{2})?\b"
    r"|\b\d{8}T\d{6}Z?\b"
    r"|\b\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?(?: (?:AM|GMT|PM))?\b"
    r"|(?i:\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b)"
    r"|(?i:\b(?:Mon|Tues?|Wed|Thur?|Fri|Sat|Sun)\b)"
    r")"
)

# number: hex (0x / 4-or-8 hex digits after whitespace) and decimal (ported from "number").
_NUMBER = (
    r"(?P<number>"
    r"(?<=\s)(?:0x[0-9a-fA-F]+|(?:[0-9a-fA-F]{4}){1,2})\b"
    r"|(?<!\w)(?<![_\d.])(?<!\S-)\d+(?:\.\d+)*(?:e[+-]\d+)?%?(?![_-])(?=\b|\s)"
    r")"
)

# Master token regex, groups ordered exactly as linux.lexer top-level includes:
# keyword -> permissions -> option -> operator -> string -> ip -> mac -> datetime -> number.
TOKEN_RE = re.compile(
    "(?P<kw_error>" + _KW_ERROR + ")"
    "|(?P<kw_ok>" + _KW_OK + ")"
    "|(?P<kw_warn>" + _KW_WARN + ")"
    "|(?P<kw_info>" + _KW_INFO + ")"
    "|" + _PERM
    + "|" + _OPTION
    + "|" + _OPERATOR
    + "|" + _STRING
    + "|" + _IP
    + "|" + _MAC
    + "|" + _DATETIME
    + "|" + _NUMBER
)

_KEYWORD_COLORS = {
    "kw_error": C_ERROR,
    "kw_ok": C_SUCCESS,
    "kw_warn": C_WARN,
    "kw_info": C_INFO,
}
_SIMPLE_COLORS = {
    "operator": C_PUNCT,
    "string": C_STRING,
    "ip": C_HEADING,
    "mac": C_HEADING,
    "datetime": C_HEADING,
    "number": C_NUMERIC,
}


def _sgr(code: str, value: str) -> str:
    if not value:
        return value
    return f"\033[{code}m{value}{ANSI_RESET}"


def _color_permissions(value: str) -> str:
    out: list[str] = []
    for char in value:
        if char in "bcdlp":
            out.append(_sgr(C_DEBUG, char))
        elif char == "r":
            out.append(_sgr(C_INFO, char))
        elif char == "w":
            out.append(_sgr(C_WARN, char))
        elif char in "xsStT":
            out.append(_sgr(C_ERROR, char))
        elif char in _OPERATOR_CHARS:
            out.append(_sgr(C_PUNCT, char))
        else:
            out.append(char)
    return "".join(out)


def _color_option(value: str) -> str:
    if "=" in value:
        flag, _, val = value.partition("=")
        return _sgr(C_OPTION, flag) + _sgr(C_DIFF, "=") + _sgr(C_INFO, val)
    return _sgr(C_OPTION, value)


class TerminalAnsiHighlighter:
    """Ports WindTerm 2.7.0's linux syntax scheme to the Agent PTY output stream.

    Mirrors `terminal/schemes/linux/linux.lexer` token rules and emits 24-bit truecolor
    ANSI using the exact `dige-black` scope colors, so non-ANSI command output (ps, df,
    free, ip, logs, dates, numbers, permissions, keywords) renders the same colors as
    WindTerm. Lines that already carry ANSI/control sequences pass through untouched so
    full-screen programs (vim/top/less) and color-emitting commands are never disturbed.
    """

    def feed(self, data: str) -> str:
        if not data:
            return data
        parts = re.split(r"(\r\n|\n|\r)", data)
        output: list[str] = []
        index = 0
        while index < len(parts):
            body = parts[index]
            sep = parts[index + 1] if index + 1 < len(parts) else ""
            if sep:
                output.append(self.color_line(body) + sep)
            else:
                output.append(body)
            index += 2
        return "".join(output)

    def color_line(self, line: str) -> str:
        if not line:
            return line
        if ANSI_OR_CONTROL_RE.search(line):
            return line
        if self._looks_like_shell_input(line):
            return line
        return TOKEN_RE.sub(self._color_token, line)

    def _color_token(self, match: re.Match[str]) -> str:
        kind = match.lastgroup
        if kind in _KEYWORD_COLORS:
            return _sgr(_KEYWORD_COLORS[kind], match.group())
        if kind == "perm":
            return _color_permissions(match.group())
        if kind == "option":
            return _color_option(match.group())
        return _sgr(_SIMPLE_COLORS[kind], match.group())

    def _looks_like_shell_input(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if ";" in stripped or "|" in stripped or "&&" in stripped or "||" in stripped:
            return True
        return bool(re.match(r"^(cd|printf|echo|cat|grep|awk|sed|tail|head|sudo|nohup|python3?|bash|sh)\b", stripped))


@dataclass
class PtySession:
    id: str
    process: subprocess.Popen
    reader_task: asyncio.Task
    master_fd: int | None = None
    highlighter: TerminalAnsiHighlighter | None = None
    cwd: str = ""


class PtyService:
    def __init__(self, on_output: OutputCallback, on_cwd: CwdCallback | None = None) -> None:
        self.on_output = on_output
        self.on_cwd = on_cwd
        self.sessions: dict[str, PtySession] = {}

    async def open(self, shell: str, cwd: str, argv: list[str] | None = None) -> str:
        session_id = uuid.uuid4().hex[:12]
        cwd_path = str(Path(cwd).expanduser())
        command = self._build_command(shell, argv)
        env = self._build_env()
        if os.name == "nt":
            process = subprocess.Popen(
                command,
                cwd=cwd_path,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=False,
                env=env,
            )
            task = asyncio.create_task(self._read_pipe_loop(session_id, process))
            self.sessions[session_id] = PtySession(session_id, process, task, cwd=cwd_path)
        else:
            master_fd, slave_fd = os.openpty()

            def _preexec() -> None:
                os.setsid()
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

            process = subprocess.Popen(
                command,
                cwd=cwd_path,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                text=False,
                close_fds=True,
                preexec_fn=_preexec,
                env=env,
            )
            os.close(slave_fd)
            task = asyncio.create_task(self._read_pty_loop(session_id, master_fd))
            self.sessions[session_id] = PtySession(session_id, process, task, master_fd, TerminalAnsiHighlighter(), cwd_path)
        await self.emit_cwd(session_id)
        return session_id

    def _build_command(self, shell: str, argv: list[str] | None) -> list[str]:
        if argv and all(isinstance(item, str) and item for item in argv):
            command = argv
        elif os.name == "nt":
            command = [shell]
        else:
            command = shlex.split(shell) if " " in shell else [shell]

        if os.name != "nt" and self._is_bash_command(command):
            return [command[0], "--rcfile", str(self._ensure_bash_bootstrap()), "-i"]
        return command

    def _is_bash_command(self, command: list[str]) -> bool:
        if not command:
            return False
        return Path(command[0]).name == "bash"

    def _ensure_bash_bootstrap(self) -> Path:
        base_dir = Path(tempfile.gettempdir()) / "smartwebride-terminal"
        base_dir.mkdir(parents=True, exist_ok=True)
        rc_path = base_dir / "bashrc"
        rc_path.write_text(BASH_RC_TEMPLATE, encoding="utf-8")
        return rc_path

    def _build_env(self) -> dict[str, str]:
        env = {**os.environ}
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["CLICOLOR"] = "1"
        return env

    async def input(self, session_id: str, data: str) -> None:
        session = self.sessions[session_id]
        if session.master_fd is not None:
            await asyncio.to_thread(os.write, session.master_fd, data.encode("utf-8", errors="ignore"))
        elif session.process.stdin:
            session.process.stdin.write(data.encode("utf-8", errors="ignore"))
            session.process.stdin.flush()
        if "\n" in data or "\r" in data:
            asyncio.create_task(self._emit_cwd_after_prompt(session_id))

    async def _emit_cwd_after_prompt(self, session_id: str) -> None:
        await asyncio.sleep(0.12)
        await self.emit_cwd(session_id)

    async def emit_cwd(self, session_id: str) -> None:
        if not self.on_cwd:
            return
        session = self.sessions.get(session_id)
        if not session:
            return
        cwd = session.cwd
        if os.name != "nt":
            try:
                cwd = os.readlink(f"/proc/{session.process.pid}/cwd")
            except (OSError, PermissionError):
                cwd = session.cwd
        if cwd and cwd != session.cwd:
            session.cwd = cwd
        if cwd:
            await self.on_cwd(session_id, cwd)

    async def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self.sessions[session_id]
        if session.master_fd is None:
            return

        def _resize() -> None:
            import fcntl
            import struct
            import termios

            size = struct.pack("HHHH", max(5, rows), max(20, cols), 0, 0)
            fcntl.ioctl(session.master_fd, termios.TIOCSWINSZ, size)

        await asyncio.to_thread(_resize)

    async def close(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if not session:
            return
        session.reader_task.cancel()
        if session.process.poll() is None:
            if os.name != "nt":
                try:
                    os.killpg(os.getpgid(session.process.pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                session.process.terminate()
        if session.master_fd is not None:
            try:
                os.close(session.master_fd)
            except OSError:
                pass

    async def _read_pipe_loop(self, session_id: str, process: subprocess.Popen) -> None:
        assert process.stdout is not None
        while True:
            data = await asyncio.to_thread(process.stdout.readline)
            if not data:
                break
            await self.on_output(session_id, data.decode("utf-8", errors="ignore"))

    async def _read_pty_loop(self, session_id: str, master_fd: int) -> None:
        while True:
            try:
                data = await asyncio.to_thread(os.read, master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            output = data.decode("utf-8", errors="ignore")
            session = self.sessions.get(session_id)
            if session and session.highlighter:
                output = session.highlighter.feed(output)
            await self.on_output(session_id, output)
