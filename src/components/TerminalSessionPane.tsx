import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  buildTerminalWsUrl,
  closeTerminalSession
} from '../lib/terminalApi';

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected';

export interface TerminalTab {
  id: string;
  sessionId: string;
  slaveId: string;
  name: string;
  host: string;
  shell: string;
  status: TerminalStatus;
}

export interface TerminalSessionPaneHandle {
  closeSession: () => Promise<void>;
  closeSocket: () => void;
  fitAndFocus: () => void;
  reconnect: () => void;
  stop: () => void;
  writeSaved: (path: string, size: number) => void;
}

interface TerminalSessionPaneProps {
  active: boolean;
  dataTestId?: string;
  defaultRoot: string;
  onCwdChange: (cwd: string) => void;
  onServerClosedReasonChange?: (reason: string) => void;
  onStatusChange: (status: TerminalStatus) => void;
  readOnly: boolean;
  system: string;
  tab: TerminalTab;
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

export const TerminalSessionPane = forwardRef<TerminalSessionPaneHandle, TerminalSessionPaneProps>(function TerminalSessionPane({
  active,
  dataTestId = 'web-ssh-terminal',
  defaultRoot,
  onCwdChange,
  onServerClosedReasonChange,
  onStatusChange,
  readOnly,
  system,
  tab
}, ref) {
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
  const firstMessageTimerRef = useRef<number | null>(null);
  const hasOutputRef = useRef(false);
  const hasServerMessageRef = useRef(false);
  const warmupTimerRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  const serverClosedReasonRef = useRef('');

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = SMARTSSH_TERMINAL_THEME;
    }
  });

  const updateStatus = useCallback((nextStatus: TerminalStatus) => {
    onStatusChange(nextStatus);
  }, [onStatusChange]);

  const clearFirstMessageTimer = useCallback(() => {
    if (firstMessageTimerRef.current !== null) {
      window.clearTimeout(firstMessageTimerRef.current);
      firstMessageTimerRef.current = null;
    }
  }, []);

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
      hasServerMessageRef.current = false;
      serverClosedReasonRef.current = '';
      onServerClosedReasonChange?.('');
      clearFirstMessageTimer();
      firstMessageTimerRef.current = window.setTimeout(() => {
        firstMessageTimerRef.current = null;
        if (hasServerMessageRef.current || serverClosedReasonRef.current) return;
        updateStatus('disconnected');
        term.write('\r\n\x1b[1;33m[连接超时] Center session 已建立，但没有收到 Agent/PTY 输出。请重连或查看 Center/Agent 日志。\x1b[0m\r\n');
      }, 4000);
      try {
        sendResize(socket, term);
      } catch {
        // Retry through warmup.
      }
      if (!readOnly) {
        if (system.toLowerCase().includes('linux')) {
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
        hasServerMessageRef.current = true;
        clearFirstMessageTimer();
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
          onServerClosedReasonChange?.(reason);
          updateStatus('disconnected');
          term.write(`\r\n\x1b[1;33m[会话已关闭] ${reason}\x1b[0m\r\n`);
          socket.close();
        } else if (message.type === 'cwd') {
          updateStatus('connected');
          onCwdChange(message.data || defaultRoot);
        } else if (message.type === 'error') {
          updateStatus('disconnected');
          term.write(`\r\n\x1b[1;31m[错误] ${message.message || message.data || 'terminal error'}\x1b[0m\r\n`);
        }
      } catch {
        hasServerMessageRef.current = true;
        clearFirstMessageTimer();
        term.write(String(event.data));
      }
    };

    socket.onerror = () => {
      clearFirstMessageTimer();
      updateStatus('disconnected');
      term.write('\r\n\x1b[1;31m[连接错误]\x1b[0m\r\n');
    };

    socket.onclose = () => {
      clearFirstMessageTimer();
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
  }, [clearFirstMessageTimer, defaultRoot, onCwdChange, onServerClosedReasonChange, readOnly, sendResize, system, tab.sessionId, updateStatus]);

  const fitAndFocus = useCallback(() => {
    try {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    } catch {
      // Retried on the next resize.
    }
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
  }, []);

  const reconnect = useCallback(() => {
    socketRef.current?.close();
    updateStatus('connecting');
    terminalRef.current?.write('\r\n\x1b[1;36m[正在重连...]\x1b[0m\r\n');
    if (terminalRef.current) connectSocket(terminalRef.current);
  }, [connectSocket, updateStatus]);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || readOnly) return;
    socket.send(JSON.stringify({ type: 'input', data: '\u0003' }));
    terminalRef.current?.focus();
  }, [readOnly]);

  const closeSession = useCallback(async () => {
    socketRef.current?.close();
    await closeTerminalSession(tab.sessionId).catch(() => undefined);
    updateStatus('disconnected');
  }, [tab.sessionId, updateStatus]);

  const writeSaved = useCallback((path: string, size: number) => {
    terminalRef.current?.writeln(`\r\n[SmartSSH] saved ${path} (${size} bytes)`);
    terminalRef.current?.focus();
  }, []);

  useImperativeHandle(ref, () => ({
    closeSession,
    closeSocket,
    fitAndFocus,
    reconnect,
    stop,
    writeSaved
  }), [closeSession, closeSocket, fitAndFocus, reconnect, stop, writeSaved]);

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
      if (firstMessageTimerRef.current !== null) {
        window.clearTimeout(firstMessageTimerRef.current);
        firstMessageTimerRef.current = null;
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
      fitAndFocus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active, fitAndFocus]);

  return (
    <div
      className="xterm-host xterm-host-smartssh"
      ref={terminalElementRef}
      data-testid={dataTestId}
    />
  );
});
