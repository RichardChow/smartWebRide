import unittest
import asyncio

from server.app import main as app_main
from server.app.agent_hub import AgentHub, TerminalSession, build_terminal_argv
from server.app.slave_registry import SlaveRegistry


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

    async def test_terminal_cwd_message_is_forwarded_to_browser_queue(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", object())  # type: ignore[arg-type]
        connection.agent_to_center_session["a1"] = "s1"
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        hub._sessions["s1"].output_queues.add(queue)

        await hub.handle_agent_message(connection, '{"type":"terminal.cwd","sessionId":"a1","cwd":"/root/debug"}')

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "cwd", "data": "/root/debug"})
        self.assertEqual(hub._sessions["s1"].history_snapshot(), [{"type": "cwd", "data": "/root/debug"}])

    async def test_terminal_output_is_buffered_for_later_attach(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", object())  # type: ignore[arg-type]
        connection.agent_to_center_session["a1"] = "s1"
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        hub._sessions["s1"].output_queues.add(queue)

        await hub.handle_agent_message(connection, '{"type":"terminal.output","sessionId":"a1","data":"hello\\n"}')

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "output", "data": "hello\n"})
        self.assertEqual(hub._sessions["s1"].history_snapshot(), [{"type": "output", "data": "hello\n"}])

    def test_find_reusable_terminal_session_matches_slave_and_holder(self):
        hub = AgentHub()
        self._seed(hub)
        hub._sessions["s1"].created_at = 1.0
        hub._sessions["s2"].created_at = 2.0

        self.assertEqual(hub.find_reusable_terminal_session("vm1", "Humphrey").session_id, "s2")
        self.assertIsNone(hub.find_reusable_terminal_session("vm1", "Alice"))
        self.assertIsNone(hub.find_reusable_terminal_session("vm1", ""))

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


class TerminalSessionRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_create_terminal_session_reuses_existing_holder_session(self):
        old_registry = app_main.registry
        old_hub = app_main.hub

        class FakeAgent:
            def __init__(self) -> None:
                self.agent_to_center_session: dict[str, str] = {}

            async def request(self, message_type: str, payload: dict, timeout: float = 15) -> dict:
                return {"agentSessionId": payload["sessionId"]}

        try:
            app_main.registry = SlaveRegistry()
            app_main.hub = AgentHub()
            app_main.registry.mark_agent_online("vm1", "test-agent", ["/tmp"])
            app_main.registry.lock("vm1", "Humphrey")
            app_main.hub._agents["vm1"] = FakeAgent()  # type: ignore[assignment]

            first = await app_main.create_terminal_session("vm1", "Humphrey")
            second = await app_main.create_terminal_session("vm1", "Humphrey")

            self.assertEqual(first.id, second.id)
            self.assertEqual(len(app_main.hub.list_terminal_sessions()), 1)
        finally:
            app_main.registry = old_registry
            app_main.hub = old_hub


if __name__ == "__main__":
    unittest.main()
