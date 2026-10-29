import { readFile } from "node:fs/promises";
import {
  createOtaRollout,
  createOtaRecovery,
  OtaControlError,
  type Database,
} from "@drone-fleet/database";
import {
  envelopeSchema,
  parseTrustStore,
  verifyEnvelope,
  artifactRoot,
  verifyStoredArtifact,
  compatibleUpgrade,
  compatibleRuntime,
} from "@drone-fleet/releases";
import { otaDeviceSnapshotSchema } from "./deployment-schema.js";
import type { DeploymentOptions } from "./deployment-repository.js";

export function createDeploymentRecovery(
  db: Database,
  options: DeploymentOptions,
  clock?: () => Date,
) {
  return createOtaRecovery(db, {
    clock,
    async validate(input, current, kind, currentEnvelope) {
      const envelope = envelopeSchema.parse(input);
      verifyEnvelope(
        envelope,
        parseTrustStore(await readFile(options.trustStorePath, "utf8")),
      );
      await verifyStoredArtifact(
        await artifactRoot(options.directory),
        envelope.manifest,
      );
      const state = otaDeviceSnapshotSchema.parse(current);
      if (
        !(kind === "RETRY"
          ? compatibleUpgrade(envelope.manifest, state)
          : compatibleRuntime(envelope.manifest, state))
      )
        throw new OtaControlError(409, "INCOMPATIBLE_DEVICE");
      if (kind === "ROLLBACK") {
        const previous = envelopeSchema.parse(currentEnvelope);
        if (
          !envelope.manifest.rollbackCompatible ||
          !previous.manifest.rollbackCompatible ||
          envelope.manifest.stateSchemaRange !==
            previous.manifest.stateSchemaRange
        )
          throw new OtaControlError(409, "ROLLBACK_UNAVAILABLE");
      }
    },
  });
}

export function createDeploymentControl(
  db: Database,
  options: DeploymentOptions,
) {
  const rollout = createOtaRollout(db, {
    async validate(deployment, targets) {
      try {
        const envelope = envelopeSchema.parse(deployment.releaseSnapshot);
        verifyEnvelope(
          envelope,
          parseTrustStore(await readFile(options.trustStorePath, "utf8")),
        );
        await verifyStoredArtifact(
          await artifactRoot(options.directory),
          envelope.manifest,
        );
        for (const state of targets) {
          const current = otaDeviceSnapshotSchema.parse(state.snapshot);
          const same =
            current.releaseId === envelope.manifest.releaseId &&
            current.digest === envelope.manifest.digest &&
            current.version === envelope.manifest.version &&
            current.buildId === envelope.manifest.buildId;
          // 再開時の適用済み機体もruntime/capabilityの互換性は再検証する。
          if (
            !(same
              ? compatibleRuntime(envelope.manifest, current)
              : compatibleUpgrade(envelope.manifest, current))
          )
            throw new Error("incompatible");
        }
      } catch {
        throw new OtaControlError(409, "RELEASE_OR_DEVICE_UNAVAILABLE");
      }
    },
  });
  return {
    act: rollout.act,
    recover: createDeploymentRecovery(db, options).request,
  };
}
