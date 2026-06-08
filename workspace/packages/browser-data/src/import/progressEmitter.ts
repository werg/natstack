import type { ImportDataType, ImportPhase, ImportProgress } from "../types.js";

export type ProgressCallback = (progress: ImportProgress) => void;

/**
 * Progress tracking for import operations.
 * Emits ImportProgress events at each phase transition.
 */
export class ProgressEmitter {
  private readonly requestId: string;
  private readonly callback: ProgressCallback;

  constructor(requestId: string, callback: ProgressCallback) {
    this.requestId = requestId;
    this.callback = callback;
  }

  emit(
    dataType: ImportDataType,
    phase: ImportPhase,
    itemsProcessed: number,
    totalItems?: number,
    error?: string,
  ): void {
    this.callback({
      requestId: this.requestId,
      dataType,
      phase,
      itemsProcessed,
      totalItems,
      error,
    });
  }

  copying(dataType: ImportDataType): void {
    this.emit(dataType, "copying", 0);
  }

  reading(dataType: ImportDataType, processed: number, total?: number): void {
    this.emit(dataType, "reading", processed, total);
  }

  decrypting(dataType: ImportDataType, processed: number, total?: number): void {
    this.emit(dataType, "decrypting", processed, total);
  }

  normalizing(dataType: ImportDataType, processed: number, total?: number): void {
    this.emit(dataType, "normalizing", processed, total);
  }

  storing(dataType: ImportDataType, processed: number, total?: number): void {
    this.emit(dataType, "storing", processed, total);
  }

  done(dataType: ImportDataType, count: number): void {
    this.emit(dataType, "done", count, count);
  }

  error(dataType: ImportDataType, message: string): void {
    this.emit(dataType, "error", 0, undefined, message);
  }
}
