import * as z from 'zod'

export const Pos = z.object({ x: z.number(), y: z.number() })
export type Pos = z.TypeOf<typeof Pos>
