import { Actyx, AqlEventMessage } from "@actyx/sdk";

export const queryAql = async <T>(actyx: Actyx, query: string) => (await actyx.queryAql(query))
  .filter((x): x is AqlEventMessage => x.type === 'event')
  .map((x) => ({ payload: x.payload as T, meta: x.meta }))
