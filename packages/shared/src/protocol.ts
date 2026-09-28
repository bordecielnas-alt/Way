import { z } from 'zod';
import type { PoiLite } from './poi.ts';

const ViewFields = {
  res: z.number().int().min(0).max(8),
  cells: z.array(z.string()).max(64),
  tStart: z.number().int(),
  tEnd: z.number().int(),
  filter: z.string().default('all'),
};

/** Client -> server: "this is what I'm looking at". */
export const ViewMessage = z.object({ type: z.literal('view'), ...ViewFields });
export type ViewMessage = z.infer<typeof ViewMessage>;

/**
 * Client -> server, while the viewer stays still: "load this too, in case".
 * Ring 0 is the view itself (enriched in the background with level 2);
 * rings 1+ are the places and periods around it, farther and farther.
 */
export const PrefetchMessage = z.object({ type: z.literal('prefetch'), ring: z.number().int().min(0).max(64), ...ViewFields });
export type PrefetchMessage = z.infer<typeof PrefetchMessage>;

export const ClientMessage = z.discriminatedUnion('type', [ViewMessage, PrefetchMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  /** `background`: points around the view, kept in memory for later. */
  | { type: 'pois'; pois: PoiLite[]; background?: boolean }
  /** Searches running for the view: `pending` fast ones (level 1), `ai` web + AI ones (level 2). */
  | { type: 'status'; pending: number; ai: number };
