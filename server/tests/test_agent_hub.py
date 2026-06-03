import unittest
import asyncio

from server.app.agent_hub import AgentHub, TerminalSession, build_terminal_argv


class TerminalArgvTest(unittest.TestCase):
    def test_linux_bash_uses_login_interactive_shell(self):
        self.assertEqual(build_terminal_argv("/bin/bash"), ["/bin/bash", "--login", "-i"])

    def test_windows_powershell_keeps_no_logo(self):
        self.assertEqual(build_terminal_argv("powershell.exe"), ["powershell.exe", "-NoLogo"])


class AgentHubSessionTest(unittest.IsolatedAsyncioTestCase):
    def _seed(self, hub: AgentHub) -> None:
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        hub._sessions["s2"] = TerminalSession("s2", "vm1", "a2", "/bin/bash", holder="Humphrey")
        hub._sessions["s3"] = TerminalSession("s3", "vm2", "a3", "/bin/bash", holder="Alice")

    def test_list_slave_sessions_filters_by_slave(self):
        hub = AgentHub()
        self._seed(hub)
        self.assertEqual({s.session_id for s in hub.list_slave_sessions("vm1")}, {"s1", "s2"})

    async def test_close_slave_sessions_removes_only_target_slave(self):
        hub = AgentHub()
        self._seed(hub)
        closed = await hub.close_slave_sessions("vm1")  # 无 agent 注册 → 仅本地清理
        self.assertEqual(set(closed), {"s1", "s2"})
        self.assertIsNone(hub.get_terminal_session("s1"))
        self.assertIsNone(hub.get_terminal_session("s2"))
        self.assertIsNotNone(hub.get_terminal_session("s3"))

    async def test_close_slave_sessions_notifies_browser_reason(self):
        hub = AgentHub()
        self._seed(hub)
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        session = hub.get_terminal_session("s1")
        session.output_queues.add(queue)

        await hub.close_slave_sessions("vm1", "已被 Humphrey 强制接管：紧急调试")

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "closed", "message": "已被 Humphrey 强制接管：紧急调试"})

    def test_stale_agent_disconnect_does_not_remove_new_connection(self):
        hub = AgentHub()
        old_connection = hub.attach_agent("vm2", object())  # type: ignore[arg-type]
        new_connection = hub.attach_agent("vm2", object())  # type: ignore[arg-type]
        hub._sessions["s3"] = TerminalSession("s3", "vm2", "a3", "/bin/bash", holder="Alice")

        self.assertFalse(hub.detach_agent("vm2", old_connection))
        self.assertTrue(hub.is_online("vm2"))
        self.assertIsNotNone(hub.get_terminal_session("s3"))

        self.assertTrue(hub.detach_agent("vm2", new_connection))
        self.assertFalse(hub.is_online("vm2"))
        self.assertIsNone(hub.get_terminal_session("s3"))


if __name__ == "__main__":
    unittest.main()
