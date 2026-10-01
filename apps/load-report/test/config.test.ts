import { describe, expect, it } from "vitest";

import { loadLoadReportConfig } from "../src/config.js";

describe("loadLoadReportConfig", () => {
  it("loads multiple input report paths", () => {
    expect(
      loadLoadReportConfig({
        LOAD_TEST_ID: "test-1",
        LOAD_GENERATOR_REPORT_PATHS: "a.json, b.json",
        LOAD_INGESTOR_REPORT_PATHS: "ingestor.json",
      }),
    ).toEqual({
      testId: "test-1",
      generatorReportPaths: ["a.json", "b.json"],
      ingestorReportPaths: ["ingestor.json"],
      outputPath: "load-results/test-1-report.json",
    });
  });

  it("requires both report types", () => {
    expect(() =>
      loadLoadReportConfig({
        LOAD_TEST_ID: "test-1",
        LOAD_GENERATOR_REPORT_PATHS: "a.json",
      }),
    ).toThrow("LOAD_INGESTOR_REPORT_PATHS is required");
  });
});
