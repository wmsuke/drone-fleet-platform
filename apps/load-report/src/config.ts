export interface LoadReportConfig {
  testId: string;
  generatorReportPaths: string[];
  ingestorReportPaths: string[];
  outputPath: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function paths(environment: NodeJS.ProcessEnv, name: string): string[] {
  const values = required(environment, name)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new TypeError(`${name} is required`);
  return values;
}

export function loadLoadReportConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LoadReportConfig {
  const testId = required(environment, "LOAD_TEST_ID");
  return {
    testId,
    generatorReportPaths: paths(environment, "LOAD_GENERATOR_REPORT_PATHS"),
    ingestorReportPaths: paths(environment, "LOAD_INGESTOR_REPORT_PATHS"),
    outputPath:
      environment.LOAD_AGGREGATE_REPORT_PATH ??
      `load-results/${testId}-report.json`,
  };
}
