import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { ArrowLeft, FolderOpen, LogOut, Plus, RotateCw, Server, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteFileEditor } from './RemoteFileEditor';
import { SftpSidebar } from './SftpSidebar';
import {
  buildTerminalWsUrl,
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

interface TerminalTab {
  id: string;
  sessionId: string;
  slaveId: string;
  name: string;
  host: string;
  shell: string;
  status: 'connecting' | 'connected' | 'disconnected';
}

const SMARTSSH_TERMINAL_THEME = {
  background: '#1c1c1c',
  foreground: '#F8F8F2',
  cursor: '#F8F8F2',
  cursorAccent: '#1c1c1c',
  selectionBackground: 'rgba(0, 101, 224, 0.40)',
  selectionForeground: '#F8F8F2',
  black: '#333333',
  red: '#C4265E',
  green: '#86B42B',
  yellow: '#D0A500',
  blue: '#3465A4',
  magenta: '#8C6BC8',
  cyan: '#56ADBC',
  white: '#e3e3dd',
  brightBlack: '#666666',
  brightRed: '#f92672',
  brightGreen: '#A6E22E',
  brightYellow: '#9e862f',
  brightBlue: '#819aff',
  brightMagenta: '#AE81FF',
  brightCyan: '#66D9EF',
  brightWhite: '#f8f8f2'
};

function getDefaultRoot(roots: string[]): string {
  return roots.find((root) => {
    const normalized = root.replaceAll('\\', '/').replace(/\/$/, '');
    return normalized.startsWith('/home/') && normalized.split('/').length === 3;
  }) ?? roots[0] ?? '/';
}

export function TerminalView({ slaveSession, currentUser, forceReadOnly = false, active = true, releaseNonce = 0, onBack, onSessionClosed, onReleaseSlave }: TerminalViewProps) {
  const readOnly = useMemo(() => forceReadOnly || isTerminalReadOnly(slaveSession, currentUser), [forceReadOnly, slaveSession, currentUser]);
  const [tab, setTab] = useState<TerminalTab | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [resolving, setResolving] = useState(false);

  const handleTerminalStatusChange = useCallback((status: TerminalTab['status']) => {
    setTab((current) => current ? { ...current, status } : current);
  }, []);

  useEffect(() => {
    if (!tab) return;
    void closeTerminalSession(tab.sessionId).catch(() => undefined);
    setTab(null);
  }, [releaseNonce]);

  useEffect(() => {
    if (!slaveSession) return;
    setConnectionError('');

    if (!active) return;
    if (tab?.slaveId === slaveSession.slaveId) return;
    if (readOnly) return;

    setResolving(true);
    createTerminalSession(slaveSession.slaveId, currentUser)
      .then((session) => {
        setTab({
          id: `terminal-${session.id}`,
          sessionId: session.id,
          slaveId: session.slaveId,
          name: slaveSession.name,
          host: slaveSession.host,
          shell: session.shell,
          status: 'connecting'
        });
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
        <button className="smartssh-tab icon-only" disabled type="button" aria-label="打开新连接">
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
          readOnly={readOnly}
          active={active}
          onStatusChange={handleTerminalStatusChange}
          onSessionClosed={() => {
            setTab(null);
            onSessionClosed();
            onBack();
          }}
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
  readOnly,
  active,
  onStatusChange,
  onSessionClosed,
  onReleaseSlave
}: {
  slaveSession: SlaveSession;
  tab: TerminalTab;
  readOnly: boolean;
  active: boolean;
  onStatusChange: (status: TerminalTab['status']) => void;
  onSessionClosed: () => void;
  onReleaseSlave: () => void;
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const resizeDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const initializedRef = useRef(false);
  const lastResizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const lastObservedRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const resizeSendTimerRef = useRef<number | null>(null);
  const hasOutputRef = useRef(false);
  const warmupTimerRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  const serverClosedReasonRef = useRef('');

  const defaultRoot = useMemo(() => getDefaultRoot(slaveSession.allowedRoots), [slaveSession.allowedRoots.join('\n')]);
  const [status, setStatus] = useState<TerminalTab['status']>('connecting');
  const [sftpOpen, setSftpOpen] = useState(true);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [terminalCwd, setTerminalCwd] = useState(defaultRoot);
  const [serverClosedReason, setServerClosedReason] = useState('');

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = SMARTSSH_TERMINAL_THEME;
    }
  });

  const updateStatus = useCallback((nextStatus: TerminalTab['status']) => {
    setStatus(nextStatus);
    onStatusChange(nextStatus);
  }, [onStatusChange]);

  const sendResize = useCallback((socket: WebSocket, term: Terminal) => {
    const cols = Math.max(20, term.cols || 80);
    const rows = Math.max(5, term.rows || 24);
    if (lastResizeRef.current.cols === cols && lastResizeRef.current.rows === rows) return;
    lastResizeRef.current = { cols, rows };
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }, []);

  const connectSocket = useCallback((term: Terminal) => {
    const socket = new WebSocket(buildTerminalWsUrl(tab.sessionId));
    socketRef.current = socket;

    socket.onopen = () => {
      updateStatus('connecting');
      hasOutputRef.current = false;
      serverClosedReasonRef.current = '';
      setServerClosedReason('');
      try {
        sendResize(socket, term);
      } catch {
        // Retry through warmup.
      }
      if (!readOnly) {
        if (slaveSession.system.toLowerCase().includes('linux')) {
          try {
            socket.send(JSON.stringify({ type: 'input', data: 'stty -ixon -ixoff >/dev/null 2>&1 || true\n' }));
          } catch {
            // Warmup retries will still run.
          }
        }
        if (warmupTimerRef.current !== null) window.clearInterval(warmupTimerRef.current);
        let attempts = 0;
        warmupTimerRef.current = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN || readOnly) return;
          attempts += 1;
          try {
            sendResize(socket, term);
            socket.send(JSON.stringify({ type: 'input', data: '\n' }));
          } catch {
            // Ignore and keep retrying within warmup budget.
          }
          if (hasOutputRef.current || attempts >= 6) {
            if (warmupTimerRef.current !== null) {
              window.clearInterval(warmupTimerRef.current);
              warmupTimerRef.current = null;
            }
          }
        }, 240);
      }
      window.setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // xterm fit can fail briefly while hidden; the next resize will retry.
        }
        term.focus();
      }, 100);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type: string; data?: string; message?: string };
        if (message.type === 'output') {
          if (!hasOutputRef.current) {
            hasOutputRef.current = true;
            updateStatus('connected');
            try {
              fitAddonRef.current?.fit();
              sendResize(socket, term);
            } catch {
              // Fit is retried on resize.
            }
            if (warmupTimerRef.current !== null) {
              window.clearInterval(warmupTimerRef.current);
              warmupTimerRef.current = null;
            }
          }
          term.write(message.data ?? '');
        } else if (message.type === 'closed') {
          const reason = message.message || message.data || '会话已被服务端关闭。';
          serverClosedReasonRef.current = reason;
          setServerClosedReason(reason);
          updateStatus('disconnected');
          term.write(`\r\n\x1b[1;33m[会话已关闭] ${reason}\x1b[0m\r\n`);
          socket.close();
        } else if (message.type === 'cwd') {
          setTerminalCwd(message.data || defaultRoot);
        } else if (message.type === 'error') {
          term.write(`\r\n\x1b[1;31m[错误] ${message.message || message.data || 'terminal error'}\x1b[0m\r\n`);
        }
      } catch {
        term.write(String(event.data));
      }
    };

    socket.onerror = () => {
      updateStatus('disconnected');
      term.write('\r\n\x1b[1;31m[连接错误]\x1b[0m\r\n');
    };

    socket.onclose = () => {
      updateStatus('disconnected');
      if (serverClosedReasonRef.current) return;
      term.write('\r\n\x1b[1;33m[连接已断开，点击重连]\x1b[0m\r\n');
    };

    dataDisposableRef.current?.dispose();
    dataDisposableRef.current = term.onData((data) => {
      if (!readOnly && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    resizeDisposableRef.current?.dispose();
    resizeDisposableRef.current = term.onResize(({ cols, rows }) => {
      if (!activeRef.current) return;
      // 尾部防抖：把一连串 fit 抖动（如 80↔81）合并成尺寸稳定后的一次发送，
      // 避免 resize → SIGWINCH → bash 重绘 → 输出 → 再触发 fit 的反馈环。
      if (resizeSendTimerRef.current !== null) window.clearTimeout(resizeSendTimerRef.current);
      resizeSendTimerRef.current = window.setTimeout(() => {
        resizeSendTimerRef.current = null;
        if (lastResizeRef.current.cols === cols && lastResizeRef.current.rows === rows) return;
        lastResizeRef.current = { cols, rows };
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      }, 180);
    });
  }, [defaultRoot, readOnly, sendResize, slaveSession.system, tab.sessionId, updateStatus]);

  useEffect(() => {
    if (initializedRef.current || !terminalElementRef.current) return undefined;
    initializedRef.current = true;

    const term = new Terminal({
      cursorBlink: true,
      disableStdin: readOnly,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: SMARTSSH_TERMINAL_THEME
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(terminalElementRef.current);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    let fitTimer: number | null = null;
    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // Hidden terminals are refit after they become visible again.
      }
    };
    const scheduleFit = () => {
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        fit();
      }, 80);
    };

    requestAnimationFrame(fit);
    window.setTimeout(fit, 50);
    window.setTimeout(() => {
      fit();
      term.focus();
    }, 200);

    term.write(`\x1b[1;36m[SmartSSH] 正在通过 smartWebRide Center 连接 ${tab.name}...\x1b[0m\r\n`);
    connectSocket(term);

    const observer = new ResizeObserver((entries) => {
      if (!activeRef.current) return;
      // 仅在被观察容器的像素尺寸真正变化时才 fit；xterm 写入输出不会改变容器尺寸，
      // 因此这能阻止"输出触发的 ResizeObserver 回调"再次驱动 fit/resize 循环。
      const entry = entries[0];
      if (entry) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (lastObservedRef.current.w === w && lastObservedRef.current.h === h) return;
        lastObservedRef.current = { w, h };
      }
      scheduleFit();
    });
    observer.observe(terminalElementRef.current.parentElement ?? terminalElementRef.current);
    window.addEventListener('resize', scheduleFit);

    return () => {
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      if (resizeSendTimerRef.current !== null) {
        window.clearTimeout(resizeSendTimerRef.current);
        resizeSendTimerRef.current = null;
      }
      if (warmupTimerRef.current !== null) {
        window.clearInterval(warmupTimerRef.current);
        warmupTimerRef.current = null;
      }
      window.removeEventListener('resize', scheduleFit);
      observer.disconnect();
      dataDisposableRef.current?.dispose();
      resizeDisposableRef.current?.dispose();
      socketRef.current?.close();
      term.dispose();
      terminalRef.current = null;
      socketRef.current = null;
      initializedRef.current = false;
    };
  }, [connectSocket, readOnly, tab.name]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!activeRef.current) return;
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Retried on next resize.
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [editingFile, sftpOpen]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // The terminal may still be mounting.
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active]);

  function handleReconnect() {
    socketRef.current?.close();
    updateStatus('connecting');
    terminalRef.current?.write('\r\n\x1b[1;36m[正在重连...]\x1b[0m\r\n');
    if (terminalRef.current) connectSocket(terminalRef.current);
  }

  function handleStop() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || readOnly) return;
    socket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
    terminalRef.current?.focus();
  }

  async function handleCloseSession() {
    socketRef.current?.close();
    await closeTerminalSession(tab.sessionId).catch(() => undefined);
    updateStatus('disconnected');
    onSessionClosed();
  }

  function handleReleaseSlave() {
    // 释放 = 放弃该 slave：关闭 socket，由上层 unlock（后端会拆掉该 slave 全部 session）并返回首页。
    socketRef.current?.close();
    updateStatus('disconnected');
    onReleaseSlave();
  }

  function handleSaved(path: string, size: number) {
    terminalRef.current?.writeln(`\r\n[SmartSSH] saved ${path} (${size} bytes)`);
    terminalRef.current?.focus();
  }

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
          <button className={sftpOpen ? 'secondary-button compact active' : 'secondary-button compact'} disabled={status !== 'connected'} onClick={() => { setSftpOpen((value) => !value); setEditingFile(null); }}>
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

      <div className="smartssh-terminal-frame">
        {sftpOpen ? (
          <SftpSidebar
            slaveId={tab.slaveId}
            connectionName={tab.name}
            isOpen={sftpOpen}
            terminalCwd={terminalCwd}
            onOpenFile={setEditingFile}
            onClose={() => setSftpOpen(false)}
            readOnly={readOnly}
          />
        ) : null}

        {editingFile ? (
          <RemoteFileEditor
            slaveId={tab.slaveId}
            filePath={editingFile}
            readOnly={readOnly}
            onClose={() => setEditingFile(null)}
            onSaved={handleSaved}
          />
        ) : null}

        <div
          className="xterm-host xterm-host-smartssh"
          ref={terminalElementRef}
          data-testid="web-ssh-terminal"
          style={{ display: editingFile ? 'none' : 'block' }}
        />
      </div>

    </div>
  );
}
