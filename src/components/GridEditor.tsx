import { Columns3, ListChecks } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { findKeyword, getKeywordType, getStepArguments, getStepKeyword } from '../lib/rideLogic';
import type { KeywordIndex, RobotCase } from '../types';

interface GridEditorProps {
  cases: RobotCase[];
  keywordIndex: KeywordIndex[];
  onSelectCase: (item: RobotCase) => void;
  onKeywordSelect: (keyword: KeywordIndex) => void;
  onKeywordNavigate: (keyword: KeywordIndex) => void;
}

export function GridEditor({ cases, keywordIndex, onSelectCase, onKeywordSelect, onKeywordNavigate }: GridEditorProps) {
  const [selectedCaseId, setSelectedCaseId] = useState(cases[0]?.id ?? '');
  const selectedCase = useMemo(() => cases.find((item) => item.id === selectedCaseId) ?? cases[0], [cases, selectedCaseId]);

  useEffect(() => {
    setSelectedCaseId(cases[0]?.id ?? '');
    if (cases[0]) onSelectCase(cases[0]);
  }, [cases, onSelectCase]);

  function selectCase(item: RobotCase) {
    setSelectedCaseId(item.id);
    onSelectCase(item);
  }

  function handleKeywordAction(name: string, action: 'select' | 'navigate') {
    const keyword = findKeyword(keywordIndex, name);
    if (!keyword) return;
    if (action === 'navigate') onKeywordNavigate(keyword);
    else onKeywordSelect(keyword);
  }

  if (!selectedCase) {
    return (
      <div className="grid-empty">
        <Columns3 size={22} />
        <strong>当前文件没有 Test Cases 表格数据</strong>
        <span>切到 Text Editor 查看原始内容，或在左侧选择 `.robot` 文件。</span>
      </div>
    );
  }

  return (
    <div className="grid-editor">
      <aside className="grid-case-list">
        <div className="grid-panel-title">
          <ListChecks size={15} /> Test Cases
        </div>
        {cases.map((item) => (
          <button
            key={item.id}
            className={selectedCase.id === item.id ? 'is-selected' : ''}
            onClick={() => selectCase(item)}
            title={item.filePath}
          >
            <strong>{item.name}</strong>
            <span>{item.tags.slice(0, 3).join(', ') || item.suiteName}</span>
          </button>
        ))}
      </aside>

      <section className="grid-step-table-wrap">
        <div className="grid-summary">
          <div>
            <h3>{selectedCase.name}</h3>
            <p>{selectedCase.documentation || selectedCase.filePath}</p>
          </div>
          <span>line {selectedCase.line}</span>
        </div>
        <table className="grid-step-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Keyword</th>
              <th>Argument 1</th>
              <th>Argument 2</th>
              <th>Argument 3+</th>
            </tr>
          </thead>
          <tbody>
            {(selectedCase.steps.length ? selectedCase.steps : ['No Operation']).map((step, index) => {
              const keywordName = getStepKeyword(step) || step;
              const args = getStepArguments(step);
              const keyword = findKeyword(keywordIndex, keywordName);
              const type = getKeywordType(keywordIndex, keywordName);
              const docs = keyword?.documentation || 'Ctrl+hover 查看索引信息，Ctrl+click 或双击跳转到定义。';
              return (
                <tr key={`${step}-${index}`}>
                  <td>{index + 1}</td>
                  <td>
                    <button
                      type="button"
                      className={`keyword-token type-${type}`}
                      title={docs}
                      onMouseEnter={(event) => {
                        if (event.ctrlKey) handleKeywordAction(keywordName, 'select');
                      }}
                      onClick={(event) => handleKeywordAction(keywordName, event.ctrlKey ? 'navigate' : 'select')}
                      onDoubleClick={() => handleKeywordAction(keywordName, 'navigate')}
                    >
                      {keywordName}
                    </button>
                  </td>
                  <td>{args[0] ?? ''}</td>
                  <td>{args[1] ?? ''}</td>
                  <td>{args.slice(2).join('    ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
