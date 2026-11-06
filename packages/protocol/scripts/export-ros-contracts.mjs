import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { z } from "zod";
import { createHash } from "node:crypto";
import { fixtures as bridgeFixtures } from "../test/fixtures/bridge.mjs";
import { canonicalBridgeJson } from "../dist/bridge.js";
import { format } from "prettier";
import { rosCommandMessageSchema } from "../dist/command.js";
import { connectionStatusMessageSchema } from "../dist/connection-status.js";
import { rosObservationMessageSchema } from "../dist/ros-observation.js";
import { telemetryReceiptMessageSchema } from "../dist/telemetry-receipt.js";
import { fixtures } from "../test/fixtures/ros-observations.mjs";
import {
  bridgeEventMessageSchema,
  bridgeReceiptMessageSchema,
  adapterConfigurationSchema,
} from "../dist/bridge.js";

const schema = z.toJSONSchema(connectionStatusMessageSchema, {
  target: "draft-7",
  io: "input",
});
const outputs = [
  [
    "configuration-fixtures.json",
    await format(
      JSON.stringify(
        bridgeFixtures((value) =>
          createHash("sha256").update(canonicalBridgeJson(value)).digest("hex"),
        ),
      ),
      { parser: "json" },
    ),
  ],
  ...(await Promise.all(
    [
      ["bridge-event.schema.json", bridgeEventMessageSchema],
      ["ros-command.schema.json", rosCommandMessageSchema],
      ["bridge-receipt.schema.json", bridgeReceiptMessageSchema],
      ["adapter-configuration.schema.json", adapterConfigurationSchema],
    ].map(async ([name, schema]) => [
      name,
      await format(
        JSON.stringify(
          z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
        ),
        { parser: "json" },
      ),
    ]),
  )),
  [
    "observation-fixtures.json",
    await format(JSON.stringify(fixtures), { parser: "json" }),
  ],
  [
    "ros-observation.schema.json",
    await format(
      JSON.stringify(
        z.toJSONSchema(rosObservationMessageSchema, {
          target: "draft-7",
          io: "input",
        }),
      ),
      { parser: "json" },
    ),
  ],
  [
    "telemetry-receipt.schema.json",
    await format(
      JSON.stringify(
        z.toJSONSchema(telemetryReceiptMessageSchema, {
          target: "draft-7",
          io: "input",
        }),
      ),
      { parser: "json" },
    ),
  ],
  [
    "connection-status.schema.json",
    await format(JSON.stringify(schema), { parser: "json" }),
  ],
  [
    "status-fixtures.json",
    readFileSync(
      new URL("../test/fixtures/bridge-status.json", import.meta.url),
      "utf8",
    ),
  ],
];
for (const [name, contents] of outputs) {
  const path = fileURLToPath(
    new URL(`../../../ros/contracts/${name}`, import.meta.url),
  );
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== contents)
      throw new Error(`ROS contract drift: ${name}`);
  } else writeFileSync(path, contents);
}
