const request = {
  schemaVersion: 1,
  kind: "CANCEL_COMMAND",
  deviceId: "bridge-fixture",
  commandId: "11111111-1111-4111-8111-111111111111",
  goalId: "22222222-2222-4222-8222-222222222222",
  serverInstanceId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  cancelId: "44444444-4444-4444-8444-444444444444",
  configurationId: "a".repeat(64),
  timestamp: "2026-11-10T00:00:00.000Z",
  expiresAt: "2026-11-10T00:00:10.000Z",
  reason: "OPERATOR_REQUEST",
};
export const cancelFixtures = [
  { valid: true, message: request },
  {
    valid: false,
    message: { ...request, goalId: "00000000-0000-0000-0000-000000000000" },
  },
  { valid: false, message: { ...request, kind: "CANCEL_ALL" } },
  { valid: false, message: { ...request, requestId: request.goalId } },
  {
    valid: false,
    message: { ...request, expiresAt: "2026-11-10T00:00:11.000Z" },
  },
  { valid: false, message: { ...request, reason: "free text" } },
  { valid: false, message: { ...request, scope: "ALL" } },
];
