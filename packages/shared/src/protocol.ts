import { z } from 'zod';
import type { PoiLite } from './poi.ts';

/** Client -> server: "this is what I'm looking at". */
export const ViewMessage = z.object({
  type: z.literal('view'),
  res: z.number().int().min(0).max(8),
  cells: z.array(z.string()).max(64),
  tStart: z.number().int(),
  tEnd: z.number().int(),
  filter: z.string().default('all'),
});
export type ViewMessage = z.infer<typeof ViewMessage>;

export const ClientMessage = z.discriminatedUnion('type', [ViewMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: 'pois'; pois: PoiLite[] }
  | { type: 'status'; pending: number };
