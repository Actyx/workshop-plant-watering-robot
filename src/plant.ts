import { MachineEvent, createMachineRunner } from "@actyx/machine-runner"
import { protocol, Event } from "./protocol"
import { Pos } from "./types"
import * as z from 'zod'
import { Actyx, Tag } from "@actyx/sdk"
import { Position } from "./position"
import * as UUID from 'uuid'
import { queryAql } from "./util"

const ENDURANCE = 500

/**
 * Description of the plant’s machine: it shows the plant’s role in the swarm
 * protocol for watering.
 */

export const PlantMachine = protocol.makeMachine('plant')

export const Initial = PlantMachine.designEmpty('initial')
  .command('request', [Event.Requested], (ctx, x: Event.RequestedPayloadType) => [ctx.withTags(['waterRequest'], x)])
  .finish()

export const Requested = PlantMachine.designState('requested')
  .withPayload<{ plantId: string, position: Pos, robots: string[] }>()
  .command('assign', [Event.Assigned], (_ctx, x: Event.AssignedPayloadType) => [x])
  .finish()

export const Assigned = PlantMachine.designState('assigned')
  .withPayload<{  plantId: string, position: Pos, robotId: string }>()
  .finish()

export const Moving = PlantMachine.designState('moving')
  .withPayload<{ plantId: string, position: Pos, robotId: string, robot: Pos }>()
  .finish()

export const Done = PlantMachine.designState('done').withPayload<{ when: Date }>().finish()

export const Failed = PlantMachine.designEmpty('failed').finish()

Initial.react([Event.Requested], Requested, (_ctx, ev) => ({ ...ev.payload, robots: [] }))
Requested.react([Event.Offered], Requested, (ctx, ev) => ({ ...ctx.self, robots: [...ctx.self.robots, ev.payload.robotId] }))
Requested.react([Event.Assigned], Assigned, (ctx, ev) => ({ plantId: ctx.self.plantId, position: ctx.self.position, robotId: ev.payload.robotId }))
Requested.react([Event.Failed], Failed, () => ({}))
Assigned.react([Event.Accepted], Moving, (ctx, ev) => ({ ...ctx.self, robot: ev.payload.position }))
Moving.react([Event.Moving], Moving, (ctx, ev) => ({ ...ctx.self, robot: ev.payload.position }))
Moving.react([Event.Done], Done, (_ctx, done) => ({ when: done.meta.timestampAsDate()}))

/**
 * Besides asking to be watered, the plant also has its own behaviour, described below
 */

export type PlantState = {
  pos: Pos
  waterLevel: number
  mission: string | undefined
}

const Created = MachineEvent.design('created').withZod(z.object({ pos: Pos }))
type Created = MachineEvent.Of<typeof Created>

const WaterRequested = MachineEvent.design('waterRequested').withZod(z.object({ reqId: z.string() }))
type WaterRequested = MachineEvent.Of<typeof WaterRequested>

const WaterReceived = MachineEvent.design('waterReceived').withoutPayload()
type WaterReceived = MachineEvent.Of<typeof WaterReceived>

const WaterLevel = MachineEvent.design('waterLevel').withZod(z.object({ level: z.number() }))
type WaterLevel = MachineEvent.Of<typeof WaterLevel>

const Died = MachineEvent.design('died').withoutPayload()
type Died = MachineEvent.Of<typeof Died>

type LifecycleEvents = Created | Died
type WaterEvents = WaterRequested | WaterReceived
type AllEvents = Created | WaterRequested | WaterReceived | Died | WaterLevel

const PlantTag = Tag<AllEvents>('plant')
const LifecycleTag = Tag<Created | Died>('lifecycle')

export const runPlant = async (actyx: Actyx, id: string, stateCb: (_: PlantState) => void, diedCb: () => void) => {
  const myTag = PlantTag.withId(id)

  const history = await queryAql<LifecycleEvents>(actyx, `FROM ${myTag} & ${LifecycleTag}`)

  let lastWatered = new Date()
  let position: Pos = Position.random()
  if (history.length === 0) {
    // create fresh plant
    await actyx.publish(myTag.and(LifecycleTag).applyTyped({ type: 'created', pos: position }))
  } else {
    const { meta, payload } = history.at(-1)!
    if (payload.type === 'died') {
      // it already died earlier
      diedCb()
      return
    } else {
      // plant is considered watered when created; further refinement below
      lastWatered = meta.timestampAsDate()
      position = payload.pos
    }
  }

  // check if the plant has recently asked for water and not yet gotten it
  let hasRequested = await (async () => {
    const latest = (await queryAql<WaterEvents>(actyx, `
        FROM ${myTag} ORDER DESC LIMIT 1
        FILTER _.type = 'waterRequested' | _.type = 'waterReceived'`))
      .at(0)
    if (!latest) return undefined
    else if (latest.payload.type === 'waterRequested') return latest.payload.reqId
    else {
      lastWatered = latest.meta.timestampAsDate()
      return undefined
    }
  })()
  
  let currentRequest = hasRequested === undefined ? undefined : createMachineRunner(actyx, protocol.tagWithEntityId(hasRequested), Initial, undefined)
  
  /**
   * In the following we have two loops:
   * - the plant consuming water and dying when dry; also requests water when <25% water level
   * - possibly waiting for a robot to water it
   */

  const requestWater = async (newRequest: boolean = true) => {
    if (newRequest) {
      const reqId = UUID.v4()
      await actyx.publish(myTag.applyTyped({ type: 'waterRequested', reqId }))
      currentRequest = createMachineRunner(actyx, protocol.tagWithEntityId(reqId), Initial, undefined)
      hasRequested = reqId
    } else if (!currentRequest) {
      return
    }
    for await (const state of currentRequest) {
      if (state.is(Initial)) {
        await state.cast().commands()?.request({ plantId: id, position })
      } else if (state.is(Requested) && state.payload.robots.length > 0) {
        await state.cast().commands()?.assign({ robotId: state.payload.robots[0] })
      } else if (state.is(Done)) {
        await actyx.publish(myTag.applyTyped({ type: 'waterReceived' }))
        currentRequest = undefined
        hasRequested = undefined
        lastWatered = state.payload.when
        return
      }
    }
  }  

  // follow up on previously uncompleted request if any
  requestWater(false)

  for (;;) {
    const now = new Date()
    const elapsed = now.getTime() - lastWatered.getTime()
    const waterLevel = 100 - elapsed / ENDURANCE
    stateCb({ pos: position, waterLevel, mission: hasRequested })
    await actyx.publish(myTag.applyTyped({ type: 'waterLevel', level: waterLevel }))

    if (waterLevel <= 0) {
      await actyx.publish(myTag.and(LifecycleTag).applyTyped({ type: 'died' }))
      diedCb()
      return
    }

    if (waterLevel < 25 && !currentRequest) {
      // run the request for water in the background, it will eventually update lastWatered
      requestWater()
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export const followPlant = (actyx: Actyx, id: string, stateCb: (_: PlantState) => void, diedCb: () => void) => {
  const myTag = PlantTag.withId(id)

  let interval: NodeJS.Timeout | null = null

  let pos: Pos = Position.random()
  let waterLevel = 100
  let mission: string | undefined = undefined

  const cancelAql = actyx.subscribeAql(`FROM ${myTag}`, (resp) => {
    if (resp.type === 'offsets') {
      interval = setInterval(() => stateCb({ pos, waterLevel, mission }), 300)
      return
    }

    if (resp.type !== 'event') return
    const { payload } = resp

    const created = Created.parse(payload)
    if (created.success) {
      pos = created.event.pos
    }

    const req = WaterRequested.parse(payload)
    if (req.success) {
      mission = req.event.reqId
    }

    const rec = WaterReceived.parse(payload)
    if (rec.success) {
      waterLevel = 100
      mission = undefined
    }

    const level = WaterLevel.parse(payload)
    if (level.success) {
      waterLevel = level.event.level
    }

    const died = Died.parse(payload)
    if (died.success) {
      diedCb()
      cancel()
    }
  }, (err) => console.log('followPlant stopped due to error:', err))

  const cancel = () => {
    interval && clearInterval(interval)
    cancelAql()
  }

  return cancel
}
