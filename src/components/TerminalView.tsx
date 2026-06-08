import { ArrowLeft, FolderOpen, LogOut, Plus, RotateCw, Server, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { RemoteFileEditor } from './RemoteFileEditor';
import { SftpSidebar } from './SftpSidebar';
import { TerminalSessionPane } from './TerminalSessionPane';
import type { TerminalSessionPaneHandle, TerminalStatus, TerminalTab } from './TerminalSessionPane';
import {
  closeTerminalSession,
  createTerminalSession
} from '../lib/terminalApi';
import { getDefaultShell, isTerminalReadOnly } from '../lib/terminalLogic';
import type { SlaveSession } from '../types';

interface TerminalViewProps {
  slaveSession: SlaveSession | null;
  currentUser: string;
  forceReadOnly?: boolean;
  active?: boolean;
  releaseNonce?: number;
  onBack: () => void;
  onSessionClosed: () => void;
  onReleaseSlave: () => void;
}

function getDefaultRoot(roots: string[]): string {
  return roots.find((root) => {
    const normalized = root.replaceAll('\\', '/').replace(/\/$/, '');
    return normalized.startsWith('/home/') && normalized.split('/').length === 3;
  }) ?? roots[0] ?? '/';
}

function buildTerminalTab(session: { id: string; slaveId: string; shell: string }, slaveSession: SlaveSession, name = slaveSession.name): TerminalTab {
  return {
    id: `terminal-${session.id}`,
    sessionId: session.id,
    slaveId: session.slaveId,
    name,
    host: slaveSession.host,
    shell: session.shell,
    status: 'connecting'
  };
}

export function TerminalView({ slaveSession, currentUser, forceReadOnly = false, active = true, releaseNonce = 0, onBack, onSessionClosed, onReleaseSlave }: TerminalViewProps) {
  const readOnly = useMemo(() => forceReadOnly || isTerminalReadOnly(slaveSession, currentUser), [forceReadOnly, slaveSession, currentUser]);
  const [tab, setTab] = useState<TerminalTab | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [resolving, setResolving] = useState(false);
  const [splitRequestNonce, setSplitRequestNonce] = useState(0);

  const resetSplitRequest = useCallback(() => {
    setSplitRequestNonce(0);
  }, []);

  const handleTerminalStatusChange = useCallback((status: TerminalStatus) => {
    setTab((current) => current ? { ...current, status } : current);
  }, []);

  useEffect(() => {
    resetSplitRequest();
    if (!tab) return;
    void closeTerminalSession(tab.sessionId).catch(() => undefined);
    setTab(null);
    setConnectionError('');
    setResolving(false);
  }, [releaseNonce, resetSplitRequest]);

  useEffect(() => {
    if (!slaveSession || !tab || tab.slaveId === slaveSession.slaveId) return;
    resetSplitRequest();
    void closeTerminalSession(tab.sessionId).catch(() => undefined);
    setTab(null);
    setConnectionError('');
    setResolving(false);
  }, [resetSplitRequest, slaveSession?.slaveId, tab?.sessionId, tab?.slaveId]);

  useEffect(() => {
    if (!slaveSession) return;
    setConnectionError('');

    if (!active) return;
    if (tab?.slaveId === slaveSession.slaveId) return;
    if (readOnly) return;

    setResolving(true);
    createTerminalSession(slaveSession.slaveId, currentUser)
      .then((session) => {
        setTab(buildTerminalTab(session, slaveSession));
      })
      .catch((err: unknown) => {
        setConnectionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setResolving(false));
  }, [active, readOnly, slaveSession?.slaveId, tab?.slaveId]);

  if (!slaveSession) {
    return (
      <section className="terminal-empty">
        <button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> 返回 Slave 列表</button>
        <p>没有选中的 slave。</p>
      </section>
    );
  }

  const disabledReason = slaveSession.mode === 'offline'
    ? 'Agent 离线，无法创建终端会话。'
    : readOnly
      ? `当前由 ${slaveSession.holder || '其他用户'} 占用，只允许查看状态。`
      : connectionError;

  return (
    <section className="smartssh-shell" aria-label="SmartSSH 终端">
      <header className="smartssh-topbar">
        <div>
          <strong>SmartSSH</strong>
          <span>smartWebRide Center / Agent</span>
        </div>
        <button className="secondary-button compact" onClick={onBack}>
          <ArrowLeft size={15} /> 返回 Slave
        </button>
      </header>

      <div className="smartssh-tabs" aria-label="会话标签">
        <button className="smartssh-tab passive" type="button">
          <Server size={15} /> Sessions
        </button>
        {tab ? (
          <button className="smartssh-tab active" type="button">
            <span className="tab-dot" />
            <span className={`tab-state ${tab.status}`} />
            {tab.name}
          </button>
        ) : null}
        <button
          className="smartssh-tab icon-only"
          disabled={!tab || readOnly}
          type="button"
          aria-label="打开同屏分屏"
          title="打开同屏分屏"
          onClick={() => setSplitRequestNonce((value) => value + 1)}
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="smartssh-node-line">
        <span className={`status-beacon status-${slaveSession.mode}`} />
        <strong>{slaveSession.name}</strong>
        <span>{slaveSession.host} / {tab?.shell || getDefaultShell(slaveSession)}</span>
        <span className={readOnly ? 'pill muted' : 'pill ok'}>{readOnly ? '只读' : resolving ? '创建会话中' : tab ? '已授权输入' : '未连接'}</span>
      </div>

      {disabledReason ? <div className="terminal-warning">{disabledReason}</div> : null}

      {readOnly || !tab ? (
        <ReadOnlyTerminal slaveSession={slaveSession} resolving={resolving} readOnly={readOnly} />
      ) : (
        <TerminalPanel
          key={tab.id}
          slaveSession={slaveSession}
          tab={tab}
          currentUser={currentUser}
          readOnly={readOnly}
          active={active}
          splitRequestNonce={splitRequestNonce}
          onStatusChange={handleTerminalStatusChange}
          onSessionClosed={() => {
            resetSplitRequest();
            setTab(null);
            onSessionClosed();
            onBack();
          }}
          onResetSplitRequest={resetSplitRequest}
          onReleaseSlave={onReleaseSlave}
        />
      )}
    </section>
  );
}

function ReadOnlyTerminal({ slaveSession, resolving, readOnly }: { slaveSession: SlaveSession; resolving: boolean; readOnly: boolean }) {
  return (
    <div className="smartssh-terminal-frame readonly">
      <div className="readonly-terminal">
        <pre>
{`[smartWebRide] ${resolving ? '正在创建 Center terminal session...' : `${slaveSession.name} 当前不可写。`}
[smartWebRide] 当前状态：${slaveSession.mode}
[smartWebRide] 持有人：${slaveSession.holder || '无'}
[smartWebRide] ${readOnly ? '只读页面不会创建 PTY，也不会写入远程文件。' : '正在等待 PTY 会话返回，请稍候。'}`}
        </pre>
      </div>
    </div>
  );
}

function TerminalPanel({
  slaveSession,
  tab,
  currentUser,
  readOnly,
  active,
  splitRequestNonce,
  onStatusChange,
  onSessionClosed,
  onResetSplitRequest,
  onReleaseSlave
}: {
  slaveSession: SlaveSession;
  tab: TerminalTab;
  currentUser: string;
  readOnly: boolean;
  active: boolean;
  splitRequestNonce: number;
  onStatusChange: (status: TerminalStatus) => void;
  onSessionClosed: () => void;
  onResetSplitRequest: () => void;
  onReleaseSlave: () => void;
}) {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const primaryPaneRef = useRef<TerminalSessionPaneHandle | null>(null);
  const splitTerminalPaneRef = useRef<TerminalSessionPaneHandle | null>(null);
  const handledSplitRequestRef = useRef(0);

  const defaultRoot = useMemo(() => getDefaultRoot(slaveSession.allowedRoots), [slaveSession.allowedRoots.join('\n')]);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [sftpOpen, setSftpOpen] = useState(true);
  const [splitTerminalTab, setSplitTerminalTab] = useState<TerminalTab | null>(null);
  const [splitFilePath, setSplitFilePath] = useState<string | null>(null);
  const [editorWidthPct, setEditorWidthPct] = useState(46);
  const [terminalCwd, setTerminalCwd] = useState(defaultRoot);
  const [serverClosedReason, setServerClosedReason] = useState('');
  const [splitError, setSplitError] = useState('');
  const [creatingSplit, setCreatingSplit] = useState(false);
  const splitActive = splitTerminalTab !== null || splitFilePath !== null;

  const updateStatus = useCallback((nextStatus: TerminalStatus) => {
    setStatus(nextStatus);
    onStatusChange(nextStatus);
  }, [onStatusChange]);

  const updateSplitStatus = useCallback((nextStatus: TerminalStatus) => {
    setSplitTerminalTab((current) => current ? { ...current, status: nextStatus } : current);
  }, []);

  const ignoreSplitCwdChange = useCallback((_cwd: string) => undefined, []);

  const handleSplitServerClosedReasonChange = useCallback((reason: string) => {
    if (reason) setSplitError(reason);
  }, []);

  const openSplitTerminal = useCallback(async () => {
    if (creatingSplit) return;
    setSftpOpen(false);
    if (splitTerminalTab) return;
    if (splitFilePath) {
      setSplitError('请先关闭当前文件分屏，再打开新的 terminal session。');
      return;
    }
    setSplitError('');
    setCreatingSplit(true);
    try {
      const session = await createTerminalSession(tab.slaveId, currentUser, {
        cwd: terminalCwd,
        mode: 'new'
      });
      setSplitTerminalTab(buildTerminalTab(session, slaveSession, `${slaveSession.name} split`));
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSplit(false);
    }
  }, [creatingSplit, currentUser, slaveSession, splitFilePath, splitTerminalTab, tab.slaveId, terminalCwd]);

  useEffect(() => {
    if (splitRequestNonce <= handledSplitRequestRef.current) return;
    handledSplitRequestRef.current = splitRequestNonce;
    void openSplitTerminal();
  }, [openSplitTerminal, splitRequestNonce]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      primaryPaneRef.current?.fitAndFocus();
      splitTerminalPaneRef.current?.fitAndFocus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [splitActive, sftpOpen]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      primaryPaneRef.current?.fitAndFocus();
      splitTerminalPaneRef.current?.fitAndFocus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active]);

  function handleReconnect() {
    primaryPaneRef.current?.reconnect();
  }

  function handleStop() {
    primaryPaneRef.current?.stop();
  }

  async function handleCloseSession() {
    await primaryPaneRef.current?.closeSession();
    onSessionClosed();
  }

  function handleReleaseSlave() {
    // 释放 = 放弃该 slave：关闭 socket，由上层 unlock（后端会拆掉该 slave 全部 session）并返回首页。
    primaryPaneRef.current?.closeSocket();
    splitTerminalPaneRef.current?.closeSocket();
    setSplitTerminalTab(null);
    setSplitFilePath(null);
    setSplitError('');
    setCreatingSplit(false);
    setSftpOpen(true);
    onResetSplitRequest();
    updateStatus('disconnected');
    onReleaseSlave();
  }

  function handleSaved(path: string, size: number) {
    primaryPaneRef.current?.writeSaved(path, size);
  }

  function handleOpenFile(path: string) {
    setSplitError('');
    setSplitFilePath(path);
  }

  async function handleCloseSplitTerminal() {
    if (!splitTerminalTab) return;
    const sessionId = splitTerminalTab.sessionId;
    splitTerminalPaneRef.current?.closeSocket();
    setSplitTerminalTab(null);
    setSplitFilePath(null);
    await closeTerminalSession(sessionId).catch(() => undefined);
    primaryPaneRef.current?.fitAndFocus();
  }

  function scheduleSplitFit() {
    window.setTimeout(() => {
      primaryPaneRef.current?.fitAndFocus();
      splitTerminalPaneRef.current?.fitAndFocus();
    }, 80);
  }

  function updateEditorWidthFromClientX(clientX: number) {
    if (!Number.isFinite(clientX)) return;
    const workbench = workbenchRef.current;
    if (!workbench) return;
    const rect = workbench.getBoundingClientRect();
    if (rect.width <= 0) return;

    const minEditor = 320;
    const minTerminal = 360;
    if (rect.width <= minEditor + minTerminal) {
      setEditorWidthPct(50);
      return;
    }

    const raw = clientX - rect.left;
    const bounded = Math.min(Math.max(raw, minEditor), rect.width - minTerminal);
    setEditorWidthPct(Math.round((bounded / rect.width) * 100));
  }

  function handleSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!workbenchRef.current) return;
    event.preventDefault();
    updateEditorWidthFromClientX(event.clientX);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function handlePointerMove(pointerEvent: PointerEvent) {
      updateEditorWidthFromClientX(pointerEvent.clientX);
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      scheduleSplitFit();
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function handleSplitKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setEditorWidthPct((value) => Math.min(70, Math.max(30, value + (event.key === 'ArrowLeft' ? -2 : 2))));
    scheduleSplitFit();
  }

  const splitStyle = splitActive ? ({ '--editor-width': `${editorWidthPct}%` } as CSSProperties) : undefined;

  return (
    <div className="smartssh-terminal-area">
      <div className="smartssh-session-header">
        <div className="smartssh-session-title">
          <TerminalSquare size={17} />
          <div>
            <strong>{tab.name}</strong>
            <span>{tab.host} / {tab.shell}</span>
          </div>
          <span className={`session-state ${status}`}>{status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '已断开'}</span>
        </div>
        <div className="smartssh-session-actions">
          <button
            className={sftpOpen ? 'secondary-button compact active' : 'secondary-button compact'}
            data-testid="sftp-toggle-button"
            disabled={status !== 'connected'}
            onClick={() => setSftpOpen((value) => !value)}
          >
            <FolderOpen size={15} /> 文件
          </button>
          {status === 'disconnected' && !serverClosedReason ? (
            <button className="secondary-button compact" onClick={handleReconnect}>
              <RotateCw size={15} /> 重连
            </button>
          ) : null}
          <button className="secondary-button compact" disabled={status !== 'connected'} onClick={handleStop}>
            <X size={15} /> Ctrl+C
          </button>
          <button className="secondary-button compact" onClick={() => void handleCloseSession()}>
            <X size={15} /> 关闭
          </button>
          <button className="release-button compact" onClick={handleReleaseSlave}>
            <LogOut size={15} /> 释放 Slave
          </button>
        </div>
      </div>

      {serverClosedReason ? <div className="terminal-warning">{serverClosedReason}</div> : null}
      {splitError ? <div className="terminal-warning">{splitError}</div> : null}
      {creatingSplit ? <div className="terminal-warning">正在打开左侧 terminal session...</div> : null}

      <div
        className={splitActive ? 'smartssh-terminal-frame split-active' : 'smartssh-terminal-frame'}
        data-testid="smartssh-terminal-frame"
        style={splitStyle}
      >
        {sftpOpen ? (
          <SftpSidebar
            slaveId={tab.slaveId}
            connectionName={tab.name}
            isOpen={sftpOpen}
            terminalCwd={terminalCwd}
            onOpenFile={handleOpenFile}
            onClose={() => setSftpOpen(false)}
            readOnly={readOnly}
          />
        ) : null}

        <div className="terminal-workbench-main" data-testid="terminal-workbench-main" ref={workbenchRef}>
          {splitTerminalTab && !splitFilePath ? (
            <section className="split-terminal-shell" data-testid="split-terminal-shell">
              <div className="split-terminal-header">
                <div>
                  <strong>{splitTerminalTab.name}</strong>
                  <span>{splitTerminalTab.host} / {splitTerminalTab.shell}</span>
                </div>
                <span className={`session-state ${splitTerminalTab.status}`}>
                  {splitTerminalTab.status === 'connected' ? '已连接' : splitTerminalTab.status === 'connecting' ? '连接中' : '已断开'}
                </span>
                <button
                  className="icon-button"
                  onClick={() => void handleCloseSplitTerminal()}
                  title="关闭左侧 terminal"
                  aria-label="关闭左侧 terminal"
                >
                  <X size={15} />
                </button>
              </div>
              <TerminalSessionPane
                ref={splitTerminalPaneRef}
                active={active}
                dataTestId="split-web-ssh-terminal"
                defaultRoot={terminalCwd}
                onCwdChange={ignoreSplitCwdChange}
                onServerClosedReasonChange={handleSplitServerClosedReasonChange}
                onStatusChange={updateSplitStatus}
                readOnly={readOnly}
                system={slaveSession.system}
                tab={splitTerminalTab}
              />
            </section>
          ) : null}

          {splitFilePath ? (
            <RemoteFileEditor
              slaveId={tab.slaveId}
              filePath={splitFilePath}
              readOnly={readOnly}
              onClose={() => setSplitFilePath(null)}
              onSaved={handleSaved}
            />
          ) : null}

          {splitActive ? (
            <div
              className="terminal-split-resizer"
              role="separator"
              aria-label="调整编辑器与终端宽度"
              aria-orientation="vertical"
              aria-valuemin={30}
              aria-valuemax={70}
              aria-valuenow={editorWidthPct}
              tabIndex={0}
              onPointerDown={handleSplitPointerDown}
              onKeyDown={handleSplitKeyDown}
            />
          ) : null}

          <TerminalSessionPane
            ref={primaryPaneRef}
            active={active}
            dataTestId="web-ssh-terminal"
            defaultRoot={defaultRoot}
            onCwdChange={setTerminalCwd}
            onServerClosedReasonChange={setServerClosedReason}
            onStatusChange={updateStatus}
            readOnly={readOnly}
            system={slaveSession.system}
            tab={tab}
          />
        </div>
      </div>

    </div>
  );
}
