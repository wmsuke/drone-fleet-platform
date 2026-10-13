export interface ClosableApi {
  close(): Promise<unknown>;
}

export interface ClosableMqttClient {
  endAsync(force?: boolean): Promise<unknown>;
}

export interface ClosableDatabaseClient {
  end(): Promise<unknown>;
}

export function createShutdown(
  app: ClosableApi,
  mqttClient: ClosableMqttClient | null,
  databaseClient: ClosableDatabaseClient,
  worker?: { stop(): Promise<void> },
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= (async () => {
      await app.close();
      await worker?.stop();
      await Promise.allSettled([
        mqttClient?.endAsync(false),
        databaseClient.end(),
      ]);
    })();

    return shutdownPromise;
  };
}
