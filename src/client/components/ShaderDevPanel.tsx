import React from 'react';
import type { ShaderState } from '../types/shared.js';

interface ShaderDevPanelProps {
  shaderState: ShaderState;
  onReload: () => void;
}

export const ShaderDevPanel: React.FC<ShaderDevPanelProps> = ({ shaderState, onReload }) => {
  const formatSource = (src: string, label: string): string => {
    if (!src) return '';
    return src.split('\n').map((line, i) => `${String(i + 1).padStart(3, ' ')}│ ${line}`).join('\n');
  };

  const sourcesDisplay = [
    { label: 'VERTEX', src: shaderState.vert },
    { label: 'FRAGMENT', src: shaderState.frag }
  ].filter(({ src }) => src).map(({ label, src }) => formatSource(src, label)).join('\n\n');

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      maxHeight: '40vh',
      overflow: 'auto',
      font: '12px monospace',
      background: '#0d1117cc',
      color: '#ddd',
      zIndex: 50000,
      padding: '6px 8px',
      backdropFilter: 'blur(6px)',
      borderTop: '1px solid #333'
    }}>
      <div style={{ marginBottom: '6px' }}>
        <b>Shader Dev</b>{' '}
        <button
          onClick={onReload}
          disabled={shaderState.loading}
          style={{
            background: '#21262d',
            border: '1px solid #30363d',
            color: '#f0f6fc',
            padding: '2px 8px',
            borderRadius: '4px',
            cursor: shaderState.loading ? 'not-allowed' : 'pointer'
          }}
        >
          {shaderState.loading ? 'loading...' : 'reload'}
        </button>{' '}
        <span style={{
          color: shaderState.loading ? '#7d8590' : shaderState.ok ? '#3fb950' : '#f85149'
        }}>
          {shaderState.loading ? 'loading…' : shaderState.ok ? 'ok' : 'error'}
        </span>
      </div>
      {!shaderState.ok && (
        <pre style={{
          whiteSpace: 'pre-wrap',
          margin: 0,
          fontSize: '11px',
          lineHeight: '1.4',
          background: '#161b22',
          padding: '8px',
          borderRadius: '4px',
          border: '1px solid #21262d'
        }}>
{sourcesDisplay}
{shaderState.log && ('\n\nLOG:\n' + shaderState.log)}
        </pre>
      )}
    </div>
  );
};
