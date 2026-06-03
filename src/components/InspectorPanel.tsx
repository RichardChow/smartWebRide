import { Boxes, Braces, ExternalLink, Library, ListTree, SearchCode } from 'lucide-react';
import type { FileOutline, KeywordIndex, Project, RobotCase } from '../types';

interface InspectorPanelProps {
  project: Project;
  selectedPath: string;
  outline: FileOutline | undefined;
  cases: RobotCase[];
  selectedCase: RobotCase | null;
  keywordIndex: KeywordIndex[];
  selectedKeyword: KeywordIndex | null;
  onKeywordSelect: (keyword: KeywordIndex) => void;
  onKeywordNavigate: (keyword: KeywordIndex) => void;
}

export function InspectorPanel({
  project,
  selectedPath,
  outline,
  cases,
  selectedCase,
  keywordIndex,
  selectedKeyword,
  onKeywordSelect,
  onKeywordNavigate
}: InspectorPanelProps) {
  const keywordCandidates = keywordIndex.filter((keyword) => keyword.usages.some((usage) => usage.filePath === selectedPath)).slice(0, 18);
  const variableMatches = (project.fileContents[selectedPath] ?? '').match(/\$\{[^}]+}/g) ?? [];
  const variables = Array.from(new Set(variableMatches)).slice(0, 18);
  const visibleKeyword = selectedKeyword ?? keywordCandidates[0] ?? null;

  return (
    <aside className="ride-inspector">
      <div className="inspector-block">
        <h3><ListTree size={16} /> Sections</h3>
        {(outline?.sections ?? []).map((section) => (
          <div key={`${section.name}-${section.line}`} className="outline-row">
            <span>{section.name}</span>
            <small>line {section.line}</small>
          </div>
        ))}
      </div>

      <div className="inspector-block">
        <h3><SearchCode size={16} /> Selected Case</h3>
        {selectedCase ? (
          <div className="selected-case-card">
            <strong>{selectedCase.name}</strong>
            <span>{selectedCase.filePath}</span>
            <p>{selectedCase.documentation || '当前 fixture 未提供 documentation。'}</p>
          </div>
        ) : (
          <p className="subtle-text">选择一个 case 后显示参数和步骤摘要。</p>
        )}
      </div>

      <div className="inspector-block">
        <h3><Library size={16} /> Library / Resource</h3>
        {(outline?.resources ?? []).map((resource) => <span key={resource} className="resource-pill">{resource}</span>)}
        {(outline?.libraries ?? []).map((library) => <span key={library} className="resource-pill library">{library}</span>)}
        {(outline?.resources.length || outline?.libraries.length) ? null : <p className="subtle-text">当前 fixture 没有解析到引用。</p>}
      </div>

      <div className="inspector-block keyword-docs-block">
        <h3><Boxes size={16} /> Keyword Docs</h3>
        {visibleKeyword ? (
          <div className="keyword-doc-card" data-testid="keyword-doc-card">
            <div className="keyword-doc-heading">
              <strong>{visibleKeyword.name}</strong>
              <span className={`keyword-type-badge type-${visibleKeyword.type}`}>{visibleKeyword.type}</span>
            </div>
            <p>{visibleKeyword.documentation || '后续接入 libdoc 后显示完整关键字文档。'}</p>
            <dl>
              <div>
                <dt>Arguments</dt>
                <dd>{visibleKeyword.arguments.join(', ') || '-'}</dd>
              </div>
              <div>
                <dt>Definition</dt>
                <dd>{visibleKeyword.sourceFile ? `${visibleKeyword.sourceFile}${visibleKeyword.line ? `:${visibleKeyword.line}` : ''}` : '未解析'}</dd>
              </div>
              <div>
                <dt>Usages</dt>
                <dd>{visibleKeyword.usages.length}</dd>
              </div>
            </dl>
            <button className="secondary-button mini" onClick={() => onKeywordNavigate(visibleKeyword)}>
              <ExternalLink size={14} /> 跳转定义
            </button>
          </div>
        ) : (
          <p className="subtle-text">在 Grid Editor 中点击 keyword 查看文档、参数和引用。</p>
        )}
      </div>

      <div className="inspector-block">
        <h3><Boxes size={16} /> Keyword Candidates</h3>
        <div className="keyword-list">
          {keywordCandidates.map((keyword) => (
            <button key={keyword.name} onClick={() => onKeywordSelect(keyword)} className={`type-${keyword.type}`}>
              {keyword.name}
            </button>
          ))}
          {cases.length > 0 && keywordCandidates.length === 0 ? <span className="subtle-text">当前文件暂无可索引 keyword。</span> : null}
        </div>
      </div>

      <div className="inspector-block">
        <h3><Braces size={16} /> Variables</h3>
        <div className="keyword-list variables">
          {variables.map((variable) => <button key={variable}>{variable}</button>)}
        </div>
      </div>
    </aside>
  );
}
