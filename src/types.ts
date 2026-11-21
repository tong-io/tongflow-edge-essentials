import type { Asset, NodeSlot, SlotInput, SlotOutput } from "tongflow";
import type { EdgeSlotOutput } from "tongflow/engine/worker";
import type { EdgeContext } from "./context.js";

export type { Asset, EdgeSlotOutput, NodeSlot, SlotInput, SlotOutput };

/**
 * A slot implementation against the plugin's internal {@link EdgeContext}.
 * `EdgeSlotOutput<S>` is `SlotOutput<S>` with ref fields allowed to carry an inline
 * `Asset` (`bytesBase64`), which the engine stores and turns into a file ref.
 */
export type SlotImpl<S extends NodeSlot> = (input: SlotInput<S>, ctx: EdgeContext) => Promise<EdgeSlotOutput<S>>;
