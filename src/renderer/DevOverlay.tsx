// Dev overlay, off by default (Cmd-Shift-D): the last action's name and time against its budget.
import { useEffect, useState } from 'react';
import { BUDGETS } from '../core/budgets';
import { onSample } from './perf';
import type { Sample } from './perf';

export function DevOverlay() {
  const [last, setLast] = useState<Sample | null>(null);
  useEffect(() => onSample(setLast), []);
  if (!last) {return <div className="dev-overlay">waiting for an action…</div>;}
  const over = last.ms > BUDGETS.keyMoveMs;
  return (
    <div className={`dev-overlay${over ? ' over' : ''}`}>
      {last.action} <b>{last.ms.toFixed(1)} ms</b>
    </div>
  );
}
