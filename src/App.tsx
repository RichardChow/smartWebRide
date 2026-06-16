import { LogOut, Server, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { HomeHeroPreview } from './components/HomeHeroPreview';
import { LoginView } from './components/LoginView';
import { SlaveStatusHome } from './components/SlaveStatusHome';
import { TerminalView } from './components/TerminalView';
import { environmentStatuses as initialEnvironmentStatuses, slaveSessions as initialSlaveSessions } from './data/mockRuntime';
import { ApiError, forceTakeover, getCurrentUser, listEnvironmentStatuses, listSlaves, lockSlave, login, logout, releaseSlave } from './lib/terminalApi';
import { canOpenWritableTerminal } from './lib/terminalLogic';
import type { AppView, AuthUser, EnvironmentStatus, SlaveSession } from './types';

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const isHomeHeroPreview = window.location.pathname === '/preview/home-hero';
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeView, setActiveView] = useState<AppView>('slaves');
  const [slaveSessions, setSlaveSessions] = useState<SlaveSession[]>(initialSlaveSessions);
  const [environmentStatuses, setEnvironmentStatuses] = useState<EnvironmentStatus[]>(initialEnvironmentStatuses);
  const [activeSlaveId, setActiveSlaveId] = useState(initialSlaveSessions[0]?.slaveId ?? '');
  const [readOnlyMode, setReadOnlyMode] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [releaseNonce, setReleaseNonce] = useState(0);
  const [centerStatus, setCenterStatus] = useState('正在读取 Center /api/slaves...');

  const currentUser = authUser?.displayName ?? '';
  const activeSlave = useMemo(
    () => slaveSessions.find((session) => session.slaveId === activeSlaveId) ?? null,
    [activeSlaveId, slaveSessions]
  );

  function updateSlaveSession(nextSession: SlaveSession | undefined) {
    if (!nextSession?.slaveId) return;
    setSlaveSessions((current) => current.map((session) => (session.slaveId === nextSession.slaveId ? nextSession : session)));
  }

  function handleUnauthorized(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      setAuthUser(null);
      setReadOnlyMode(false);
      setActiveView('slaves');
      setTerminalMounted(false);
      setCenterStatus('登录已过期，请重新登录。');
      return true;
    }
    return false;
  }

  useEffect(() => {
    let cancelled = false;

    getCurrentUser()
      .then((user) => {
        if (!cancelled) setAuthUser(user);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (!(err instanceof ApiError && err.status === 401)) {
          setCenterStatus(`Center 认证接口暂不可用：${messageFromError(err)}`);
        }
        setAuthUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser || activeView !== 'slaves') return undefined;
    let cancelled = false;

    async function refreshSlaves() {
      try {
        const liveSessions = await listSlaves();
        if (cancelled) return;
        setSlaveSessions(liveSessions);
        if (liveSessions.length > 0 && !liveSessions.some((session) => session.slaveId === activeSlaveId)) {
          setActiveSlaveId(liveSessions[0].slaveId);
        }
        try {
          const liveEnvironmentStatuses = await listEnvironmentStatuses();
          if (cancelled) return;
          setEnvironmentStatuses(liveEnvironmentStatuses);
          setCenterStatus('Center 在线，Slave 状态来自真实 Agent 心跳');
        } catch (environmentErr) {
          if (cancelled) return;
          setCenterStatus(`Center 在线，Slave 状态来自真实 Agent 心跳；环境状态使用本地示例：${messageFromError(environmentErr)}`);
        }
      } catch (err) {
        if (cancelled) return;
        if (handleUnauthorized(err)) return;
        setCenterStatus(`Center 暂不可用，当前显示本地示例数据：${messageFromError(err)}`);
      }
    }

    void refreshSlaves();
    const timer = window.setInterval(refreshSlaves, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSlaveId, activeView, authUser]);

  async function handleLogin(email: string, password: string) {
    const user = await login(email, password);
    setAuthUser(user);
    setAuthChecked(true);
    setReadOnlyMode(false);
    setActiveView('slaves');
    setTerminalMounted(false);
    setCenterStatus('登录成功，正在读取 Slave 状态...');
  }

  async function handleLogout() {
    if (activeSlave && currentUser && activeSlave.holder === currentUser) {
      await releaseSlave(activeSlave.slaveId).catch(() => undefined);
    }
    await logout().catch(() => undefined);
    setAuthUser(null);
    setReadOnlyMode(false);
    setActiveView('slaves');
    setTerminalMounted(false);
    setCenterStatus('已退出登录。');
  }

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
      const lockedSession = await lockSlave(slaveId, 'Web SSH 调试锁');
      updateSlaveSession(lockedSession);
      setReadOnlyMode(false);
    } catch (err) {
      if (handleUnauthorized(err)) return;
      const message = messageFromError(err);
      setReadOnlyMode(true);
      setCenterStatus(`Center 拒绝调试锁，已进入只读状态：${message}`);
    }

    setActiveView('terminal');
  }

  async function releaseSlaveLock(slaveId: string) {
    const session = slaveSessions.find((item) => item.slaveId === slaveId);
    if (activeSlaveId === slaveId) {
      setReleaseNonce((value) => value + 1);
      setReadOnlyMode(false);
      setActiveView('slaves');
    }

    try {
      const releasedSession = await releaseSlave(slaveId);
      updateSlaveSession(releasedSession);
      setCenterStatus(`${session?.name || slaveId} 已释放，其他人可以连接调试。`);
    } catch (err) {
      if (handleUnauthorized(err)) return;
      setCenterStatus(`释放 ${session?.name || slaveId} 失败：${messageFromError(err)}`);
      try {
        const liveSessions = await listSlaves();
        setSlaveSessions(liveSessions);
      } catch {
        // Keep the release failure visible.
      }
    }
  }

  async function forceTakeoverSlave(slaveId: string, reason: string) {
    const session = slaveSessions.find((item) => item.slaveId === slaveId);
    if (!session) return;
    try {
      const taken = await forceTakeover(slaveId, reason.trim());
      updateSlaveSession(taken);
      setCenterStatus(`已强制接管 ${session.name}（原持有人 ${session.holder || '无'}）。`);
      setActiveSlaveId(slaveId);
      setTerminalMounted(true);
      setReadOnlyMode(false);
      setActiveView('terminal');
    } catch (err) {
      if (handleUnauthorized(err)) return;
      setCenterStatus(`强制接管 ${session.name} 失败：${messageFromError(err)}`);
    }
  }

  if (!authChecked) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="login-brand">
            <span className="brand-mark">SR</span>
            <div>
              <strong>smartWebRide</strong>
              <small>正在恢复登录状态</small>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return <LoginView onLogin={handleLogin} />;
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
        <div className="entry-user account-summary">
          <UserRound size={16} />
          <span>
            <strong>{authUser.displayName}</strong>
            <small>{authUser.email}</small>
          </span>
          <button className="secondary-button compact" onClick={() => void handleLogout()} type="button">
            <LogOut size={15} />
            退出
          </button>
        </div>
      </header>

      <main className={`content-shell ${activeView === 'terminal' ? 'terminal-content-shell' : ''}`}>
        <div style={{ display: activeView === 'slaves' ? 'block' : 'none' }}>
          {isHomeHeroPreview ? (
            <HomeHeroPreview
              sessions={slaveSessions}
              environmentStatuses={environmentStatuses}
              currentUser={currentUser}
              statusMessage={centerStatus}
              onEnterSlave={enterSlave}
              onReleaseSlave={(slaveId) => void releaseSlaveLock(slaveId)}
              onForceTakeover={(slaveId, reason) => void forceTakeoverSlave(slaveId, reason)}
            />
          ) : (
            <SlaveStatusHome
              sessions={slaveSessions}
              environmentStatuses={environmentStatuses}
              currentUser={currentUser}
              statusMessage={centerStatus}
              onEnterSlave={enterSlave}
              onReleaseSlave={(slaveId) => void releaseSlaveLock(slaveId)}
              onForceTakeover={(slaveId, reason) => void forceTakeoverSlave(slaveId, reason)}
            />
          )}
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
