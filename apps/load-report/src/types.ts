export interface GeneratorDeviceResult {
  deviceId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  lastSequence: number | null;
}

export interface GeneratorReport {
  schemaVersion: 1;
  testId: string;
  sessionId: string;
  config: {
    deviceStart: number;
    deviceCount: number;
  };
  startedAt: string;
  endedAt: string;
  counters: { attempted: number; succeeded: number; failed: number };
  devices: GeneratorDeviceResult[];
}

export interface HistogramReport {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  buckets: Array<{ leMs: number | null; count: number }>;
}

export interface IngestorReport {
  schemaVersion: 1;
  testId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  counters: {
    mqttReceived: number;
    validationSucceeded: number;
    validationFailed: number;
    dbSaveSucceeded: number;
    dbSaveFailed: number;
    offlineTransitions: number;
  };
  timings: {
    deviceTimestampToMqttReceiveMs: HistogramReport;
    mqttReceiveToDbCompleteMs: HistogramReport;
  };
}

export interface PersistedTelemetry {
  deviceId: string;
  sequence: number;
}

export interface TelemetryQuery {
  deviceIds: string[];
  startedAt: Date;
  endedAt: Date;
}

export interface LoadReportRepository {
  findTelemetry(query: TelemetryQuery): Promise<PersistedTelemetry[]>;
}

export interface AggregatedHistogram extends HistogramReport {
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface LoadTestReport {
  schemaVersion: 1;
  testId: string;
  generatedAt: string;
  startedAt: string;
  endedAt: string;
  counters: {
    attempted: number;
    sentSucceeded: number;
    sentFailed: number;
    mqttReceived: number;
    validationSucceeded: number;
    validationFailed: number;
    dbSaveSucceeded: number;
    dbSaveFailed: number;
    dbPersisted: number;
    missing: number;
    missingRate: number;
    offlineTransitions: number;
  };
  timings: {
    deviceTimestampToMqttReceiveMs: AggregatedHistogram;
    mqttReceiveToDbCompleteMs: AggregatedHistogram;
  };
  sessions: Array<{
    sessionId: string;
    startedAt: string;
    endedAt: string;
    deviceIds: string[];
    counters: {
      attempted: number;
      sentSucceeded: number;
      sentFailed: number;
      dbPersisted: number;
      missing: number;
    };
    devices: Array<{
      deviceId: string;
      sentSucceeded: number;
      dbPersisted: number;
      missing: number;
      sequences: number[];
    }>;
  }>;
}
