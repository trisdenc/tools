import { IndexedImage } from './image';

/**
 * Undo entries are sparse deltas — only the pixels / cells / CGRAM slots that changed — so hundreds
 * of steps cost kilobytes. Each entry points at the exact array it modified, so undo works no
 * matter which asset is currently open. Structural edits (adding frames, optimizing tilesets…)
 * use `custom` entries with explicit undo/redo closures.
 */
export type HistoryEntry =
  | { kind: 'pixels'; label: string; img: IndexedImage; idx: Uint32Array; before: Uint8Array; after: Uint8Array }
  | { kind: 'cells'; label: string; cells: Uint16Array; idx: Uint32Array; before: Uint16Array; after: Uint16Array }
  | { kind: 'cgram'; label: string; slots: Uint16Array; before: Uint16Array; after: Uint16Array; time: number }
  | { kind: 'custom'; label: string; undo: () => void; redo: () => void; bytes?: number };

export function entryBytes(e: HistoryEntry): number {
  switch (e.kind) {
    case 'pixels':
    case 'cells':
      return e.idx.byteLength + e.before.byteLength + e.after.byteLength;
    case 'cgram':
      return e.slots.byteLength + e.before.byteLength + e.after.byteLength;
    case 'custom':
      return e.bytes ?? 64;
  }
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public limit = 1000) {}

  push(e: HistoryEntry): void {
    this.undoStack.push(e);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): HistoryEntry | undefined {
    const e = this.undoStack.pop();
    if (e) this.redoStack.push(e);
    return e;
  }

  redo(): HistoryEntry | undefined {
    const e = this.redoStack.pop();
    if (e) this.undoStack.push(e);
    return e;
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  bytes(): number {
    let n = 0;
    for (const e of this.undoStack) n += entryBytes(e);
    for (const e of this.redoStack) n += entryBytes(e);
    return n;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Records the original value of every element touched during a stroke. */
class Transaction<A extends Uint8Array | Uint16Array> {
  protected touched = new Map<number, number>();

  constructor(readonly data: A) {}

  set(idx: number, v: number): void {
    const p = this.data;
    if (!this.touched.has(idx)) this.touched.set(idx, p[idx]);
    p[idx] = v;
  }

  /** Put one element back to its value from before the transaction began. */
  restore(idx: number): void {
    const b = this.touched.get(idx);
    if (b !== undefined) this.data[idx] = b;
  }

  /** Undo everything in this transaction (used by shape tools to redraw their preview). */
  revertAll(): void {
    const p = this.data;
    this.touched.forEach((b, i) => (p[i] = b));
    this.touched.clear();
  }

  protected diff(): { idx: number[]; before: number[]; after: number[] } | null {
    const p = this.data;
    const idx: number[] = [], before: number[] = [], after: number[] = [];
    this.touched.forEach((b, i) => {
      if (p[i] !== b) {
        idx.push(i);
        before.push(b);
        after.push(p[i]);
      }
    });
    return idx.length ? { idx, before, after } : null;
  }
}

export class PixelTransaction extends Transaction<Uint8Array> {
  constructor(private img: IndexedImage) {
    super(img.pixels);
  }

  toEntry(label: string): HistoryEntry | null {
    const d = this.diff();
    if (!d) return null;
    return {
      kind: 'pixels',
      label,
      img: this.img,
      idx: Uint32Array.from(d.idx),
      before: Uint8Array.from(d.before),
      after: Uint8Array.from(d.after),
    };
  }
}

export class CellTransaction extends Transaction<Uint16Array> {
  toEntry(label: string): HistoryEntry | null {
    const d = this.diff();
    if (!d) return null;
    return {
      kind: 'cells',
      label,
      cells: this.data,
      idx: Uint32Array.from(d.idx),
      before: Uint16Array.from(d.before),
      after: Uint16Array.from(d.after),
    };
  }
}
