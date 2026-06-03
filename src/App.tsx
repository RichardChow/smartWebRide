import { Server, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { SlaveStatusHome } from './components/SlaveStatusHome';
import { TerminalView } from './components/TerminalView';
import { slaveSessions as initialSlaveSessions } from './data/mockRuntime';
import { forceTakeover, listSlaves, lockSlave, releaseSlave } from './lib/terminalApi';
import { canOpenWritableTerminal } from './lib/terminalLogic';
import type { AppView, SlaveSession } from './types';

function loadCurrentUser(): string {
  return sessionStorage.getItem('swr-user') || 'Humphrey';
}

function renewSessionLock(session: SlaveSession, currentUser: string): SlaveSession {
  const now = Date.now();
  return {
    ...session,
    mode: 'held',
    holder: currentUser,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    manualHoldReason: session.manualHoldReason || '已获取调试锁，Agent 心跳续租中',
    activeRunId: '',
    processSignal: 'none'
  };
}

export function App() {
  const [currentUser, setCurrentUser] = useState(loadCurrentUser);
  const [activeView, setActiveView] = useState<AppView>('slaves');
  const [slaveSessions, setSlaveSessions] = useState<SlaveSession[]>(initialSlaveSessions);
  const [activeSlaveId, setActiveSlaveId] = useState(initialSlaveSessions[0]?.slaveId ?? '');
  const [readOnlyMode, setReadOnlyMode] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [releaseNonce, setReleaseNonce] = useState(0);
  const [centerStatus, setCenterStatus] = useState('正在读取 Center /api/slaves...');

  const activeSlave = useMemo(
    () => slaveSessions.find((session) => session.slaveId === activeSlaveId) ?? null,
    [activeSlaveId, slaveSessions]
  );

  function updateSlaveSession(nextSession: SlaveSession) {
    setSlaveSessions((current) => current.map((session) => (session.slaveId === nextSession.slaveId ? nextSession : session)));
  }

  useEffect(() => {
    let cancelled = false;

    async function refreshSlaves() {
      try {
        const liveSessions = await listSlaves();
        if (cancelled) return;
        setSlaveSessions(liveSessions);
        setCenterStatus('Center 在线，Slave 状态来自真实 Agent 心跳');
        if (liveSessions.length > 0 && !liveSessions.some((session) => session.slaveId === activeSlaveId)) {
          setActiveSlaveId(liveSessions[0].slaveId);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCenterStatus(`Center 暂不可用，当前显示本地示例数据：${message}`);
      }
    }

    if (activeView !== 'slaves') return undefined;

    void refreshSlaves();
    const timer = window.setInterval(refreshSlaves, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSlaveId, activeView]);

  async function enterSlave(slaveId: string, readOnly: boolean) {
    const session = slaveSessions.find((item) => item.slaveId === slaveId);
    setActiveSlaveId(slaveId);
    setTerminalMounted(true);

    if (!session || readOnly || !canOpenWritableTerminal(session, currentUser)) {
      setReadOnlyMode(true);
      setActiveView('terminal');
      return;
    }

    if (session.mode !== 'idle' && session.holder === currentUser) {
      setReadOnlyMode(false);
      setActiveView('terminal');
      return;
    }

    try {
      const lockedSession = await lockSlave(slaveId, currentUser, 'Web SSH 调试锁');
      updateSlaveSession(lockedSession);
      setReadOnlyMode(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('held by') || message.includes('offline')) {
        setReadOnlyMode(true);
        setCenterStatus(`Center 拒绝调试锁，已进入只读状态：${message}`);
        setActiveView('terminal');
        return;
      }
      updateSlaveSession(renewSessionLock(session, currentUser));
      setReadOnlyMode(false);
      setCenterStatus('Center 锁接口暂不可用，已进入本地调试锁预览模式');
    }

    setActiveView('terminal');
  }

  async function releaseSlaveLock(slaveId: string) {
    const session = slaveSessions.find((item) => item.slaveId === slaveId);
    if (!session || session.holder !== currentUser) return;

    if (activeSlaveId === slaveId) {
      setReleaseNonce((value) => value + 1);
      setReadOnlyMode(false);
      setActiveView('slaves');
    }

    try {
      const releasedSession = await releaseSlave(slaveId, currentUser);
      updateSlaveSession(releasedSession);
      setCenterStatus(`${session.name} 已释放，其他人可以连接调试。`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCenterStatus(`释放 ${session.name} 失败：${message}`);
    }
  }

  async function forceTakeoverSlave(slaveId: string, reason: string) {
    const session = slaveSessions.find((item) => item.slaveId === slaveId);
    if (!session) return;
    try {
      const taken = await forceTakeover(slaveId, currentUser, reason.trim());
      updateSlaveSession(taken);
      setCenterStatus(`已强制接管 ${session.name}（原持有人 ${session.holder || '无'}）。`);
      setActiveSlaveId(slaveId);
      setTerminalMounted(true);
      setReadOnlyMode(false);
      setActiveView('terminal');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCenterStatus(`强制接管 ${session.name} 失败：${message}`);
    }
  }

  function changeCurrentUser(next: string) {
    const value = next.trim() || 'Humphrey';
    sessionStorage.setItem('swr-user', value);
    setCurrentUser(value);
  }

  return (
    <div className="app-shell">
      <header className={`topbar ${activeView === 'slaves' ? 'entry-topbar' : 'terminal-topbar'}`}>
        <div className="brand-block">
          <span className="brand-mark">SR</span>
          <div>
            <strong>smartWebRide</strong>
            <small>Slave 占用与 Web SSH 调试</small>
          </div>
        </div>

        <div className="entry-title">
          <Server size={17} />
          <span>{activeView === 'slaves' ? '选择调试环境' : 'Web SSH Terminal'}</span>
        </div>
        <div className="entry-user">
          <UserRound size={16} />
          <label>本地账号：
            <input
              className="user-input"
              value={currentUser}
              onChange={(event) => changeCurrentUser(event.target.value)}
              aria-label="当前账号"
            />
          </label>
        </div>
      </header>

      <main className={`content-shell ${activeView === 'terminal' ? 'terminal-content-shell' : ''}`}>
        <div style={{ display: activeView === 'slaves' ? 'block' : 'none' }}>
          <SlaveStatusHome
            sessions={slaveSessions}
            currentUser={currentUser}
            statusMessage={centerStatus}
            onEnterSlave={enterSlave}
            onReleaseSlave={(slaveId) => void releaseSlaveLock(slaveId)}
            onForceTakeover={(slaveId, reason) => void forceTakeoverSlave(slaveId, reason)}
          />
        </div>
        {terminalMounted ? (
          <div style={{ display: activeView === 'terminal' ? 'block' : 'none' }}>
            <TerminalView
              slaveSession={activeSlave}
              currentUser={currentUser}
              forceReadOnly={readOnlyMode}
              active={activeView === 'terminal'}
              releaseNonce={releaseNonce}
              onBack={() => {
                setReadOnlyMode(false);
                setActiveView('slaves');
              }}
              onSessionClosed={() => {
                if (activeSlaveId) void releaseSlaveLock(activeSlaveId);
              }}
              onReleaseSlave={() => {
                if (activeSlaveId) void releaseSlaveLock(activeSlaveId);
              }}
            />
          </div>
        ) : null}
      </main>

      {activeView === 'terminal' ? (
        <footer className="app-footer">
          <span>当前模式：{readOnlyMode ? '只读观察' : '可写调试'}</span>
          <span>真实 PTY 接口：smartWebRide Center / Agent / WebSocket</span>
        </footer>
      ) : null}
    </div>
  );
}
