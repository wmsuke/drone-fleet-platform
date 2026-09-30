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
  mqttClient: ClosableMqttClient,
  databaseClient: ClosableDatabaseClient,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= (async () => {
      await app.close();
      await Promise.allSettled([
        mqttClient.endAsync(false),
        databaseClient.end(),
      ]);
    })();

    return shutdownPromise;
  };
}
