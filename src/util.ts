import { Actyx, AqlEventMessage } from "@actyx/sdk";

export const queryAql = async <T>(actyx: Actyx, query: string) => (await actyx.queryAql(query))
  .filter((x): x is AqlEventMessage => x.type === 'event')
  .map((x) => ({ payload: x.payload as T, meta: x.meta }))

/**
 * multiple producer multiple consumer
 */
export const mpmc = <T>() => {
  const subs = new Set<(t: T) => unknown>();
  const self = {
    sub: (x: (t: T) => unknown) => {
      subs.add(x);
      return () => self.unsub(x)
    },
    unsub: (x: (t: T) => unknown) => subs.delete(x),
    emit: (t: T) => subs.forEach(x => x(t))
  }
  return self;
}

export const cleanup = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type CB = (...args: any[]) => unknown
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