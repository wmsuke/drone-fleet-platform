import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { z } from "zod";
import { format } from "prettier";
import { connectionStatusMessageSchema } from "../dist/connection-status.js";

const schema = z.toJSONSchema(connectionStatusMessageSchema, {
  target: "draft-7",
  io: "input",
});
const outputs = [
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
