import type { TelemetryMessage } from "@drone-fleet/protocol";

import type {
  TelemetryBatchEntry,
  TelemetryRepository,
  TelemetrySaveOutcome,
} from "./repository.js";

export interface TelemetryPersistence {
  save(
    message: TelemetryMessage,
    receivedAt: Date,
    isRetained?: boolean,
  ): Promise<TelemetrySaveOutcome | void>;
}

export interface TelemetryBatchWriterOptions {
  batchSize: number;
  flushIntervalMs: number;
  maxBufferSize: number;
}

interface PendingEntry extends TelemetryBatchEntry {
  resolve(outcome: TelemetrySaveOutcome): void;
  reject(error: unknown): void;
}

export class TelemetryBufferFullError extends Error {
  constructor(maxBufferSize: number) {
    super(`telemetry buffer reached its limit (${maxBufferSize})`);
    this.name = "TelemetryBufferFullError";
  }
}

export class TelemetryBatchWriter implements TelemetryPersistence {
  private readonly buffer: PendingEntry[] = [];
  private pendingCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly repository: TelemetryRepository,
    private readonly options: TelemetryBatchWriterOptions,
  ) {}

  save(
    message: TelemetryMessage,
    receivedAt: Date,
    isRetained = false,
  ): Promise<TelemetrySaveOutcome> {
    if (this.stopped) {
      return Promise.reject(new Error("telemetry batch writer is stopped"));
    }
    if (this.pendingCount >= this.options.maxBufferSize) {
      return Promise.reject(
        new TelemetryBufferFullError(this.options.maxBufferSize),
      );
    }

    this.pendingCount += 1;
    const completion = new Promise<TelemetrySaveOutcome>((resolve, reject) => {
      this.buffer.push({ message, receivedAt, isRetained, resolve, reject });
    });

    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
    return completion;
  }

  async flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      if (this.buffer.length > 0) void this.flush();
    });
    return this.flushing;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.clearFlushTimer();
    do {
      await this.flush();
    } while (this.pendingCount > 0);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.buffer.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private async drain(): Promise<void> {
    this.clearFlushTimer();
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.batchSize);
      try {
        const outcomes = await this.repository.saveBatch(
          batch.map(({ message, receivedAt, isRetained }) => ({
            message,
            receivedAt,
            isRetained,
          })),
        );
        if (outcomes.length !== batch.length)
          throw new Error("telemetry batch result count does not match input");
        for (const [index, entry] of batch.entries())
          entry.resolve(outcomes[index]!);
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      } finally {
        this.pendingCount -= batch.length;
      }
    }
  }
}
