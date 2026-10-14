import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  commandV2MessageSchema,
  commandAcknowledgementV2MessageSchema,
  commandAcknowledgementV3MessageSchema,
  connectionStatusMessageSchema,
  telemetryV2MessageSchema,
} from "../src/index.js";

const document = readFileSync(
  new URL("../../../docs/protocol.md", import.meta.url),
  "utf8",
);

describe("通信仕様の掲載JSON", () => {
  it.each([
    ["テレメトリ", telemetryV2MessageSchema, 2],
    ["接続状態", connectionStatusMessageSchema, 1],
    ["コマンド", commandV2MessageSchema, 2],
    ["ACK", commandAcknowledgementV2MessageSchema, 2],
    ["実行結果通知", commandAcknowledgementV3MessageSchema, 3],
  ] as const)("%sの例が実装schemaと一致する", (title, schema, version) => {
    const section = document
      .split(/^## /m)
      .find((text) => text.startsWith(`${title}\n`));
    const example = section?.match(/```json\n([\s\S]*?)```/)?.[1];
    expect(example, `${title}のJSON例が必要`).toBeDefined();
    const message = JSON.parse(example!);
    expect(message.schemaVersion).toBe(version);
    // 不正な追加項目をstripして通る例も、掲載内容との不一致として検出する。
    expect(schema.parse(message)).toEqual(message);
  });
});
