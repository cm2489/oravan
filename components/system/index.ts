/*
 * The shared primitives of the variant-B system. Import from here, not from
 * the files directly, so the surface agents all reach the same components.
 *
 * If you are about to hand-build a chip, a 6px bar, a dated stamp, or the
 * green floor-vote panel — don't. The laws they encode (color, shape, the
 * one-panel cap, the printed date) only hold if there is one implementation.
 *
 * See DESIGN.md for the two laws and the contrast ledger.
 */

export { Chip, AiMark } from './Chip';
export type { ChipProps, ChipGround } from './Chip';

export { FloorVotePanel, selectFloorVoteFeature } from './FloorVotePanel';
export type { FloorVotePanelProps } from './FloorVotePanel';

export { Gauge } from './Gauge';
export type { GaugeProps, GaugeSegment } from './Gauge';

export { Stamp } from './Stamp';
export type { StampProps } from './Stamp';
