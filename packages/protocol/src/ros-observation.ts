import { z } from "zod";
import { messageBaseSchema } from "./common.js";

const vector = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .strict();
const label = z.string().min(1).max(256);
export const rosQualitySchema = z
  .object({
    reason: z.enum([
      "VALID",
      "MISSING",
      "INVALID",
      "FRAME_MISMATCH",
      "STALE",
      "CLOCK_RESET",
      "QOS_INCOMPATIBLE",
    ]),
    stamp: z
      .object({
        sec: z.number().int(),
        nanosec: z.number().int().min(0).max(999999999),
      })
      .strict()
      .nullable(),
    timeDomain: z.enum(["ROS", "SYSTEM"]),
    clockEpoch: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .meta({
    allOf: [
      {
        if: { properties: { reason: { const: "VALID" } } },
        then: {
          properties: {
            stamp: { not: { type: "null" } },
            receivedAt: { not: { type: "null" } },
          },
        },
      },
    ],
  });

export const rosObservationPayloadSchema = z
  .object({
    source: z.literal("ROS2"),
    battery: z.number().min(0).max(100).nullable(),
    temperature: z.number().nullable(),
    position: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("LOCAL"),
            frameId: label,
            convention: z.literal("ENU"),
            unit: z.literal("m"),
            pose: vector,
            velocity: z
              .object({
                frameId: label,
                linear: vector,
                angular: vector,
                linearUnit: z.literal("m/s"),
                angularUnit: z.literal("rad/s"),
              })
              .strict()
              .nullable(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("GEODETIC"),
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            altitude: z.number().nullable(),
            altitudeReference: z.literal("WGS84_ELLIPSOID"),
            unit: z.literal("m"),
          })
          .strict(),
      ])
      .nullable(),
    flightStatus: z.enum(["IDLE", "FLYING", "RETURNING_HOME", "UNKNOWN"]),
    diagnostics: z
      .array(
        z
          .object({
            name: label,
            hardwareId: z.string().max(256),
            level: z.enum(["OK", "WARN", "ERROR", "STALE"]),
          })
          .strict(),
      )
      .max(32),
    diagnosticsTruncated: z.boolean(),
    quality: z
      .object({
        battery: rosQualitySchema,
        temperature: rosQualitySchema,
        position: rosQualitySchema,
        flightStatus: rosQualitySchema,
        diagnostics: rosQualitySchema,
      })
      .strict(),
  })
  .strict()
  .meta({
    // Zod refinementはJSON Schemaへ自動変換されないため同じ条件を生成物にも持たせる。
    allOf: [
      "battery",
      "temperature",
      "position",
      "flightStatus",
      "diagnostics",
    ].map((field) => ({
      if: {
        properties: {
          quality: {
            properties: {
              [field]: { properties: { reason: { const: "VALID" } } },
            },
          },
        },
      },
      ...(["battery", "temperature", "position"].includes(field)
        ? {
            then: { properties: { [field]: { not: { type: "null" } } } },
            else: { properties: { [field]: { type: "null" } } },
          }
        : {
            else: {
              properties: {
                [field]:
                  field === "flightStatus"
                    ? { const: "UNKNOWN" }
                    : { maxItems: 0 },
              },
            },
          }),
    })),
  });

export const rosObservationMessageSchema = z
  .object({
    ...messageBaseSchema.shape,
    sessionId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    schemaVersion: z.literal(3),
    payload: rosObservationPayloadSchema,
  })
  .strict()
  .superRefine(({ payload }, ctx) => {
    for (const field of ["battery", "temperature", "position"] as const) {
      if (
        (payload[field] !== null) !==
        (payload.quality[field].reason === "VALID")
      )
        ctx.addIssue({
          code: "custom",
          path: ["payload", field],
          message: "value and quality disagree",
        });
    }
    if (
      payload.quality.flightStatus.reason !== "VALID" &&
      payload.flightStatus !== "UNKNOWN"
    )
      ctx.addIssue({
        code: "custom",
        path: ["payload", "flightStatus"],
        message: "invalid flight state",
      });
    if (
      payload.quality.diagnostics.reason !== "VALID" &&
      payload.diagnostics.length !== 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["payload", "diagnostics"],
        message: "invalid diagnostics",
      });
    for (const quality of Object.values(payload.quality)) {
      if (
        quality.reason === "VALID" &&
        (quality.stamp === null || quality.receivedAt === null)
      )
        ctx.addIssue({
          code: "custom",
          path: ["payload", "quality"],
          message: "valid observation requires source evidence",
        });
    }
  });
export type RosObservationMessage = z.infer<typeof rosObservationMessageSchema>;
export type RosObservationPayload = z.infer<typeof rosObservationPayloadSchema>;
