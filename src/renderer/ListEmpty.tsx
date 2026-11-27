// What an empty list says: a Split with nothing left in it is done; a search with nothing found says so.
import { DoneMark } from './icons';

export function ListEmpty({ split, search }: { split: string; search?: { query: string; server?: 'searching' | 'done' } }) {
  if (search) {
    return (
      <div className="list-empty" role="status">
        <p className="list-empty-title">Nothing matches “{search.query}”</p>
        <p className="list-empty-note">
          {search.server === 'searching'
            ? 'Searching the server…'
            : search.server === 'done'
              ? 'The server has nothing either.'
              : 'Edit the search, or press ⌘↩ in it to ask the server too.'}
        </p>
      </div>
    );
  }
  return (
    <div className="list-empty" role="status">
      <DoneMark />
      <p className="list-empty-title">All done</p>
      <p className="list-empty-note">Nothing left in {split}.</p>
    </div>
  );
}
