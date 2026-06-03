import unittest
import tempfile
from datetime import timedelta
from pathlib import Path

from server.app.slave_registry import SlaveRegistry, load_slaves_from_config, utc_now


def _expire(registry: SlaveRegistry, slave_id: str) -> None:
    registry.get(slave_id).expiresAt = (utc_now() - timedelta(minutes=1)).isoformat()


class SlaveRegistryTest(unittest.TestCase):
    def test_agent_online_changes_mode_to_idle(self):
        registry = SlaveRegistry()
        slave = registry.mark_agent_online("vm1", "test-agent", ["/tmp"])
        self.assertEqual(slave.mode, "idle")
        self.assertEqual(slave.allowedRoots, ["/tmp"])

    def test_lock_rejects_second_holder(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        with self.assertRaises(ValueError):
            registry.lock("vm1", "Alice")

    def test_unlock_releases_holder_and_returns_to_idle(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")

        slave = registry.unlock("vm1", "Humphrey")

        self.assertEqual(slave.mode, "idle")
        self.assertEqual(slave.holder, "")
        self.assertEqual(slave.expiresAt, "")

    def test_loads_slaves_from_config_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "slaves.json"
            config.write_text(
                """
                {
                  "slaves": [
                    {
                      "slaveId": "lab",
                      "name": "Lab",
                      "host": "192.0.2.20",
                      "system": "Linux",
                      "allowedRoots": ["/tmp/swr-debug"]
                    }
                  ]
                }
                """,
                encoding="utf-8",
            )
            slaves = load_slaves_from_config(str(config))
            self.assertEqual(slaves["lab"].allowedRoots, ["/tmp/swr-debug"])


    def test_expired_lock_allows_new_holder(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        _expire(registry, "vm1")
        slave = registry.lock("vm1", "Alice")  # 过期且无活跃 → 可被抢
        self.assertEqual(slave.holder, "Alice")

    def test_running_blocks_expiry(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        _expire(registry, "vm1")
        registry.update_activity("vm1", True, "1234")  # 后台 Robot 在跑
        with self.assertRaises(ValueError):
            registry.lock("vm1", "Alice")
        self.assertEqual(registry.get("vm1").holder, "Humphrey")

    def test_renew_pushes_expiry(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        _expire(registry, "vm1")
        registry.renew("vm1", "Humphrey")
        self.assertFalse(registry._is_expired(registry.get("vm1")))

    def test_renew_ignores_other_holder(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        before = registry.get("vm1").expiresAt
        registry.renew("vm1", "Alice")
        self.assertEqual(registry.get("vm1").expiresAt, before)

    def test_takeover_transfers_and_returns_prev_holder(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        prev, slave = registry.takeover("vm1", "Alice", "需要紧急调试")
        self.assertEqual(prev, "Humphrey")
        self.assertEqual(slave.holder, "Alice")
        self.assertEqual(slave.mode, "held")
        self.assertEqual(slave.manualHoldReason, "需要紧急调试")

    def test_can_write_only_for_valid_holder(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.lock("vm1", "Humphrey")
        self.assertTrue(registry.can_write("vm1", "Humphrey"))
        self.assertFalse(registry.can_write("vm1", "Alice"))
        _expire(registry, "vm1")
        self.assertFalse(registry.can_write("vm1", "Humphrey"))

    def test_update_activity_sets_running_when_unheld(self):
        registry = SlaveRegistry()
        registry.mark_agent_online("vm1", "test-agent")
        registry.update_activity("vm1", True, "999")
        slave = registry.get("vm1")
        self.assertEqual(slave.mode, "running")
        self.assertEqual(slave.processSignal, "robot")
        self.assertEqual(slave.activeRunId, "999")

    def test_lock_rejects_when_agent_offline(self):
        registry = SlaveRegistry()
        with self.assertRaises(ValueError):
            registry.lock("vm1", "Humphrey")  # 默认 agentVersion 空 = 离线


if __name__ == "__main__":
    unittest.main()
