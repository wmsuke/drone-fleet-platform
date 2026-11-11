import type { z } from "zod";
import type {
  rosConfigurationSchema,
  rosHealthSchema,
  rosObservationSchema,
  rosExecutionSchema,
  rosCancelSchema,
} from "../src/ros-api.js";
import type { CommandHistoryItem } from "../src/api.js";
export const deviceId: string;
export const commandId: string;
export const base: string;
export function rosFixtures(): {
  config: z.infer<typeof rosConfigurationSchema>;
  health: z.infer<typeof rosHealthSchema>;
  sample: z.infer<typeof rosObservationSchema>;
  execution: z.infer<typeof rosExecutionSchema>;
  cancellation: z.infer<typeof rosCancelSchema>;
  history: CommandHistoryItem[];
};
