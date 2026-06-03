import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { Loader2, Save, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readRemoteFile, writeRemoteFile } from '../lib/terminalApi';

interface RemoteFileEditorProps {
  slaveId: string;
  filePath: string;
  readOnly: boolean;
  onClose: () => void;
  onSaved: (path: string, size: number) => void;
}

function getLanguageExtension(filePath: string): Extension[] {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'json':
      return [json()];
    case 'py':
    case 'python':
      return [python()];
    case 'js':
    case 'jsx':
      return [javascript({ jsx: ext === 'jsx' })];
    case 'ts':
    case 'tsx':
      return [javascript({ typescript: true, jsx: ext === 'tsx' })];
    case 'md':
    case 'markdown':
      return [markdown()];
    default:
      return [];
  }
}

function getLanguageLabel(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    bash: 'Bash',
    cfg: 'Config',
    conf: 'Config',
    css: 'CSS',
    html: 'HTML',
    ini: 'INI',
    js: 'JavaScript',
    json: 'JSON',
    jsx: 'JavaScript JSX',
    log: 'Log',
    md: 'Markdown',
    py: 'Python',
    robot: 'Robot Framework',
    resource: 'Robot Resource',
    sh: 'Shell',
    ts: 'TypeScript',
    tsx: 'TypeScript JSX',
    txt: 'Plain Text',
    xml: 'XML',
    yaml: 'YAML',
    yml: 'YAML'
  };
  return map[ext] || 'Plain Text';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RemoteFileEditor({ slaveId, filePath, readOnly, onClose, onSaved }: RemoteFileEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [fileInfo, setFileInfo] = useState<{ size: number; encoding: string } | null>(null);

  const fileName = filePath.split('/').pop() || filePath;

  const handleSave = useCallback(async () => {
    if (!viewRef.current || readOnly) return;
    const content = viewRef.current.state.doc.toString();

    try {
      setSaving(true);
      await writeRemoteFile(slaveId, filePath, content);
      setModified(false);
      setFileInfo((value) => value ? { ...value, size: content.length } : value);
      onSaved(filePath, content.length);
    } catch (err) {
      window.alert(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [slaveId, filePath, onSaved, readOnly]);

  useEffect(() => {
    let destroyed = false;

    async function initEditor() {
      try {
        setLoading(true);
        setError(null);
        setModified(false);
        const result = await readRemoteFile(slaveId, filePath);

        if (destroyed) return;

        if (result.encoding === 'base64') {
          setError('该文件是二进制文件，无法编辑。');
          return;
        }

        setFileInfo({ size: result.size, encoding: result.encoding });
        viewRef.current?.destroy();
        viewRef.current = null;

        if (!editorRef.current) return;

        const saveKeymap = keymap.of([{
          key: 'Mod-s',
          run: () => {
            editorRef.current?.dispatchEvent(new CustomEvent('editor-save'));
            return true;
          }
        }]);

        const extensions: Extension[] = [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          rectangularSelection(),
          highlightActiveLine(),
          foldGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          saveKeymap,
          oneDark,
          EditorView.editable.of(!readOnly),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: '"Cascadia Code", Consolas, monospace', overflow: 'auto' },
            '.cm-content': { minHeight: '100%' }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setModified(true);
          }),
          ...getLanguageExtension(filePath)
        ];

        viewRef.current = new EditorView({
          state: EditorState.create({ doc: result.content, extensions }),
          parent: editorRef.current
        });
      } catch (err) {
        if (!destroyed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!destroyed) setLoading(false);
      }
    }

    void initEditor();

    return () => {
      destroyed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [slaveId, filePath, readOnly]);

  useEffect(() => {
    const element = editorRef.current;
    if (!element) return undefined;
    const handler = () => void handleSave();
    element.addEventListener('editor-save', handler);
    return () => element.removeEventListener('editor-save', handler);
  }, [handleSave]);

  function handleClose() {
    if (modified && !window.confirm('文件有未保存的修改，确定关闭？')) return;
    onClose();
  }

  return (
    <section className="remote-file-editor" aria-label="远程文本编辑器">
      <div className="remote-file-editor-header">
        <div className="remote-file-title">
          {modified ? <span className="dirty-dot" title="未保存" /> : null}
          <strong title={filePath}>{fileName}</strong>
          <span title={filePath}>{filePath}</span>
        </div>
        <div className="remote-file-actions">
          <button className="secondary-button compact" disabled={readOnly || saving || !modified} onClick={() => void handleSave()} title="保存 (Ctrl+S)">
            {saving ? <Loader2 size={15} className="spin-icon" /> : <Save size={15} />}
            保存
          </button>
          <button className="icon-button" onClick={handleClose} title="关闭文件" aria-label="关闭文件">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="remote-file-body">
        <div ref={editorRef} className="remote-file-codemirror" data-testid="terminal-file-editor" />
        {loading ? (
          <div className="remote-file-overlay">
            <Loader2 size={22} className="spin-icon" />
            <span>加载中...</span>
          </div>
        ) : null}
        {error ? (
          <div className="remote-file-overlay error">
            <span>{error}</span>
          </div>
        ) : null}
      </div>

      {fileInfo && !loading && !error ? (
        <div className="remote-file-status">
          <span>{getLanguageLabel(filePath)}</span>
          <span>{fileInfo.encoding.toUpperCase()}</span>
          <span>{formatSize(fileInfo.size)}</span>
          {readOnly ? <span>只读</span> : null}
        </div>
      ) : null}
    </section>
  );
}
