import { useEffect, useMemo, useState } from 'react';
import {
  buildFlowNodes,
  buildKeywordIndex,
  collectAllTags,
  createInitialDebugState,
  createRunPlan,
  transitionDebugState,
  type DebugControl
} from '../lib/rideLogic';
import { createMockRunSession, getFileContent, getOutlineCases } from '../lib/projectUtils';
import { createInitialSelectionState } from '../lib/selectionUtils';
import type { KeywordIndex, Project, RobotCase, RunSession, SelectionState, SlaveSession } from '../types';
import { BottomDock } from './BottomDock';
import { GridEditor } from './GridEditor';
import { InspectorPanel } from './InspectorPanel';
import { RideSuiteTree } from './RideSuiteTree';
import { RideToolbar } from './RideToolbar';

interface EditorViewProps {
  project: Project;
  selectedPath: string;
  query: string;
  readOnly: boolean;
  slaveSession: SlaveSession | null;
  onSelectPath: (path: string) => void;
  onQueryChange: (value: string) => void;
  onSlaveSessionChange: (session: SlaveSession) => void;
}

export function EditorView({
  project,
  selectedPath,
  query,
  readOnly,
  slaveSession,
  onSelectPath,
  onQueryChange,
  onSlaveSessionChange
}: EditorViewProps) {
  const content = useMemo(() => getFileContent(project, selectedPath), [project, selectedPath]);
  const [draft, setDraft] = useState(content);
  const [editorMode, setEditorMode] = useState<'grid' | 'text'>('grid');
  const [selectedCase, setSelectedCase] = useState<RobotCase | null>(null);
  const [selectedKeyword, setSelectedKeyword] = useState<KeywordIndex | null>(null);
  const [runSession, setRunSession] = useState<RunSession | null>(null);
  const [selection, setSelection] = useState<SelectionState>(() => createInitialSelectionState());
  const [debugState, setDebugState] = useState(() => createInitialDebugState());
  const outline = project.fileOutlines[selectedPath];
  const cases = useMemo(() => getOutlineCases(project, selectedPath), [project, selectedPath]);
  const keywordIndex = useMemo(() => buildKeywordIndex(project), [project]);
  const allTags = useMemo(() => collectAllTags(project), [project]);
  const runPlan = useMemo(
    () => createRunPlan(project, slaveSession?.slaveId ?? 'local', selection, readOnly),
    [project, readOnly, selection, slaveSession?.slaveId]
  );
  const flowNodes = useMemo(() => buildFlowNodes(selectedCase, debugState), [selectedCase, debugState]);

  useEffect(() => {
    setDraft(content);
  }, [content]);

  useEffect(() => {
    setSelectedCase(cases[0] ?? null);
    setSelectedKeyword(null);
  }, [selectedPath, project.id, cases]);

  useEffect(() => {
    setSelection(createInitialSelectionState());
    setDebugState(createInitialDebugState());
    setRunSession(null);
  }, [project.id]);

  function handleSelectCase(testCase: RobotCase) {
    setSelectedCase(testCase);
  }

  function handleKeywordNavigate(keyword: KeywordIndex) {
    setSelectedKeyword(keyword);
    if (keyword.sourceFile && project.fileContents[keyword.sourceFile]) onSelectPath(keyword.sourceFile);
  }

  function handleTagModeChange(tag: string, mode: 'include' | 'exclude' | 'none') {
    setSelection((current) => {
      const includedTags = current.includedTags.filter((item) => item !== tag);
      const excludedTags = current.excludedTags.filter((item) => item !== tag);
      if (mode === 'include') includedTags.push(tag);
      if (mode === 'exclude') excludedTags.push(tag);
      return { ...current, includedTags, excludedTags };
    });
  }

  function handleDebugControl(control: DebugControl) {
    if (readOnly) return;
    setDebugState((current) => transitionDebugState(current, control));

    if (control === 'run') {
      const target = runPlan.selectedCases.map((testCase) => testCase.name).join(', ') || selection.includedTags.join(', ') || selectedCase?.name || query || project.name;
      const session = createMockRunSession(project, target, slaveSession?.slaveId ?? 'local');
      setRunSession(session);
      if (slaveSession) onSlaveSessionChange({ ...slaveSession, mode: 'running', activeRunId: session.id, processSignal: 'robot' });
    }

    if (control === 'stop' && slaveSession) {
      onSlaveSessionChange({
        ...slaveSession,
        mode: 'held',
        activeRunId: '',
        processSignal: 'none',
        manualHoldReason: slaveSession.manualHoldReason || '运行已停止，手动保持占用用于问题排查'
      });
    }
  }

  return (
    <div className={`ride-workspace ${readOnly ? 'is-readonly' : ''}`}>
      <RideToolbar
        project={project}
        selectedPath={selectedPath}
        query={query}
        readOnly={readOnly}
        slaveSession={slaveSession}
        debugState={debugState}
        runPlan={runPlan}
        onQueryChange={onQueryChange}
        onDebugControl={handleDebugControl}
      />

      {readOnly ? <div className="readonly-banner">当前 slave 被占用，本会话只允许查看 case、keyword、报告和 diff。</div> : null}

      <div className="ride-main-grid">
        <aside className="suite-explorer">
          <div className="pane-title">Test Suite Explorer</div>
          <RideSuiteTree
            project={project}
            selectedPath={selectedPath}
            selection={selection}
            onSelectionChange={setSelection}
            onSelectPath={onSelectPath}
            onSelectCase={handleSelectCase}
          />
        </aside>

        <main className="ride-editor">
          <div className="editor-tabbar">
            <button className={editorMode === 'grid' ? 'is-active' : ''} onClick={() => setEditorMode('grid')}>Grid Editor</button>
            <button className={editorMode === 'text' ? 'is-active' : ''} onClick={() => setEditorMode('text')}>Text Editor</button>
            <span>{selectedPath || project.name}</span>
          </div>
          {editorMode === 'grid' ? (
            <GridEditor
              cases={cases}
              keywordIndex={keywordIndex}
              onSelectCase={handleSelectCase}
              onKeywordSelect={setSelectedKeyword}
              onKeywordNavigate={handleKeywordNavigate}
            />
          ) : (
            <textarea
              className="code-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              readOnly={readOnly}
            />
          )}
        </main>

        <InspectorPanel
          project={project}
          selectedPath={selectedPath}
          outline={outline}
          cases={cases}
          selectedCase={selectedCase}
          keywordIndex={keywordIndex}
          selectedKeyword={selectedKeyword}
          onKeywordSelect={setSelectedKeyword}
          onKeywordNavigate={handleKeywordNavigate}
        />
      </div>

      <BottomDock
        project={project}
        selectedCase={selectedCase}
        runSession={runSession}
        runPlan={runPlan}
        selection={selection}
        allTags={allTags}
        debugState={debugState}
        flowNodes={flowNodes}
        readOnly={readOnly}
        onTagModeChange={handleTagModeChange}
        onArgumentFileChange={(argumentFile) => setSelection((current) => ({ ...current, argumentFile }))}
        onDebugControl={handleDebugControl}
      />
    </div>
  );
}
