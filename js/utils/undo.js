export class UndoStack {
  constructor(limit = 50) {
    this._undo = [];
    this._redo = [];
    this._limit = limit;
  }

  // Call BEFORE mutating the model; pass current JSON snapshot
  push(snapshot) {
    this._undo.push(snapshot);
    if (this._undo.length > this._limit) this._undo.shift();
    this._redo = [];
  }

  // Returns previous snapshot to restore, or null
  undo(currentSnapshot) {
    if (!this._undo.length) return null;
    this._redo.push(currentSnapshot);
    return this._undo.pop();
  }

  // Returns next snapshot to restore, or null
  redo(currentSnapshot) {
    if (!this._redo.length) return null;
    this._undo.push(currentSnapshot);
    return this._redo.pop();
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  clear() { this._undo = []; this._redo = []; }
}
