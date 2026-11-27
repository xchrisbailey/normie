// Search drops from the header: type, and the list behind fills with what matches. Enter shows them in the list;
// Esc closes the search.
import type { RefObject } from 'react';
import { SearchIcon } from './icons';
import { Panel } from './Panel';

export interface SearchState {
  query: string;
  count: number;
  server?: 'searching' | 'done';
}

export function SearchPanel({
  search,
  input,
  onQuery,
  onShow,
  onClose,
  onServer,
}: {
  search: SearchState;
  input: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  /** Enter or ↓: the panel goes, the results stay in the list for j, k and Enter. */
  onShow: () => void;
  onClose: () => void;
  /** Also ask the servers (⌘↩). */
  onServer: () => void;
}) {
  return (
    <Panel title="Search" className="search-panel" onClose={onClose}>
      <div className="search-bar">
        <SearchIcon />
        <input
          ref={input}
          value={search.query}
          placeholder='Search: words, "a phrase", from:, to:, subject:'
          aria-label="Search"
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onServer();
            } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
              e.preventDefault();
              onShow();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <span className="count">{search.count}</span>
        {search.server === 'searching' ? (
          <span className="sync-note">Searching the server…</span>
        ) : search.server === 'done' ? (
          <span className="sync-note">Server searched</span>
        ) : search.query.trim() ? (
          <button type="button" className="quiet search-server" onClick={onServer} tabIndex={-1}>
            Search the server
          </button>
        ) : null}
      </div>
      <footer className="panel-foot">
        <span>
          <kbd>↵</kbd> show in the list
        </span>
        <span>
          <kbd>⌘↵</kbd> also search the server
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </footer>
    </Panel>
  );
}

/** In the header while results fill the list and the panel is closed: what was searched. A press edits it. */
export function SearchChip({ search, onEdit }: { search: SearchState; onEdit: () => void }) {
  return (
    <button type="button" className="search-chip" onClick={onEdit} aria-label={`Search: ${search.query}. Edit the search`}>
      <SearchIcon />
      <span className="search-chip-query">{search.query || 'Search'}</span>
      <span className="count">{search.count}</span>
      {search.server === 'done' && <span className="sync-note">with the server</span>}
    </button>
  );
}
