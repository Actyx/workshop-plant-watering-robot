import { Actyx, AqlEventMessage } from "@actyx/sdk";

export const queryAql = async <T>(actyx: Actyx, query: string) => (await actyx.queryAql(query))
  .filter((x): x is AqlEventMessage => x.type === 'event')
  .map((x) => ({ payload: x.payload as T, meta: x.meta }))

export const cleanup = () => {
  type CB = () => void
  let subs = new Set<CB>();
  const self = {
    add: (x: CB) => subs.add(x),
    clean: () => {
      Array.from(subs).forEach(x => x());
      subs = new Set();
    }
  }
  return self;
}
export type Cleanup = ReturnType<typeof cleanup>
