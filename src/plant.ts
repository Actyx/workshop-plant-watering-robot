import { MachineEvent, createMachineRunner } from "@actyx/machine-runner"
import { wateringProtocol, Event } from "./protocol"
import { Pos } from "./types"
import * as z from 'zod'
import { Actyx, Tag } from "@actyx/sdk"
import { Position } from "./position"
import * as UUID from 'uuid'
import { Cleanup, queryAql } from "./util"
import { VELOCITY } from "./robot"

/** millisecons it takes for the plant to consume 1% of water */
const ENDURANCE = 500

/**
 * Description of the plant’s machine: it shows the plant’s role in the swarm
 * protocol for watering.
 */

export const PlantMachine = wateringProtocol.makeMachine('plant')

export const PlantInitial = PlantMachine.designEmpty('initial')
  .command('request', [Event.Request], (ctx, x: Event.RequestPayloadType) => [ctx.withTags(['waterRequest'], x)])
  .finish()

type RobotWhere = {
  id: string
  pos: Pos
}

export const Requested = PlantMachine.designState('requested')
  .withPayload<{ plantId: string, position: Pos, robots: RobotWhere[] }>()
  .command('assign', [Event.Assign], (_ctx, x: Event.AssignPayloadType) => [x])
  .finish()

export const Assigned = PlantMachine.designState('assigned')
  .withPayload<{  plantId: string, position: Pos, robotId: string }>()
  .finish()

export const Moving = PlantMachine.designState('moving')
  .withPayload<{ plantId: string, position: Pos, robotId: string, robot: Pos }>()
  .finish()

export const Done = PlantMachine.designState('done').withPayload<{ when: Date }>().finish()

export const Failed = PlantMachine.designEmpty('failed').finish()

PlantInitial.react([Event.Request], Requested, (_ctx, ev) => ({ ...ev.payload, robots: [] }))
Requested.react([Event.Offer], Requested, (ctx, ev) => ({
  ...ctx.self,
  robots: [
    ...ctx.self.robots,
    {
      id: ev.payload.robotId,
      pos: ev.payload.position,
    }
  ]
}))
Requested.react([Event.Assign], Assigned, (ctx, ev) => ({ plantId: ctx.self.plantId, position: ctx.self.position, robotId: ev.payload.robotId }))
Requested.react([Event.Fail], Failed, () => ({}))
Assigned.react([Event.Accept], Moving, (ctx, ev) => ({ ...ctx.self, robot: ev.payload.position }))
Assigned.react([Event.Fail2], Failed, () => ({}))
Moving.react([Event.Move], Moving, (ctx, ev) => ({ ...ctx.self, robot: ev.payload.position }))
Moving.react([Event.Finish], Done, (_ctx, done) => ({ when: done.meta.timestampAsDate()}))

// 
// Besides asking to be watered, the plant also has its own behaviour, described below
// 

/**
 * This is the state we’re sending to the UI for display.
 */
export type PlantState = {
  pos: Pos
  waterLevel: number
  mission: string | undefined
}

// 
// Declaration of the event types emitted by the plant for its own purposes.
// 

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

/**
 * This function runs a plant, updating its state and asking for water when needed.
 * It should only be used to start the plant that is owned by the current app instance.
 * Other plants can be followed (passively) using `followPlant`.
 * 
 * @param actyx Actyx SDK instance
 * @param id name of the plant
 * @param stateCb callback to update the UI with the plant’s state
 * @param diedCb callback to call when the plant dies
 */
export const runPlant = async (actyx: Actyx, id: string, stateCb: (_: PlantState) => void, diedCb: () => void, cleanup: Cleanup) => {
  // this is the basic set of tags for the plant ('plant' and 'plant:<id>')
  const myTag = PlantTag.withId(id)

  // get all created/died events for this plant
  const history = await queryAql<LifecycleEvents>(actyx, `FROM ${myTag} & ${LifecycleTag}`)

  // we calculate the water level based on when it was last watered
  let lastWatered = new Date()

  // make up a random position for the plant or retrieve the previously made up one from the event history
  let position: Pos = Position.random()
  if (history.length === 0) {
    // create fresh plant and store its location so we find it next time
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
        FROM ${myTag} ORDER DESC LIMIT 1 -- only retrieve the latest watering event
        FILTER _.type = 'waterRequested' | _.type = 'waterReceived'`))
      .at(0)
    if (!latest) return undefined
    else if (latest.payload.type === 'waterRequested') return latest.payload.reqId
    else {
      // latest was `waterReceived`, so the plant was watered
      lastWatered = latest.meta.timestampAsDate()
      return undefined
    }
  })()
  
  // prepare a machine-runner if there is an outstanding request
  let currentRequest = hasRequested === undefined
    ? undefined
    : createMachineRunner(actyx, wateringProtocol.tagWithEntityId(hasRequested), PlantInitial, undefined)
  cleanup.add(() => currentRequest?.destroy())
  
  // 
  // In the following we have two loops:
  // - the plant consuming water and dying when dry; also requests water when <25% water level
  // - possibly waiting for a robot to water it, as implemented in `requestWater`
  // 

  const requestWater = async (newRequest: boolean = true) => {
    // newRequest is false when we want to follow up on an existing request
    if (newRequest) {
      const reqId = UUID.v4()
      await actyx.publish(myTag.applyTyped({ type: 'waterRequested', reqId }))
      currentRequest = createMachineRunner(actyx, wateringProtocol.tagWithEntityId(reqId), PlantInitial, undefined)
      hasRequested = reqId
    } else if (!currentRequest) {
      return
    }
    // run the request protocol for water
    for await (const state of currentRequest) {
      // this lists only the states in which we need to do something, which is fine because
      // the plant will die eventually if it doesn't get water
      if (state.is(PlantInitial)) {
        await state.cast().commands()?.request({ plantId: id, position, reqId: hasRequested! })
      } else if (state.is(Requested) && state.payload.robots.length > 0) {
        // check if any robot is close enough and pick the one that is closest
        let closest: RobotWhere | undefined = undefined
        let closestDist = Number.MAX_VALUE
        for (const robot of state.payload.robots) {
          const dist = Position.fromPos(robot.pos).direction(Position.fromPos(position)).length()
          if (dist < closestDist) {
            closest = robot
            closestDist = dist
          }
        }
        if (closest && closestDist < 24 * ENDURANCE * VELOCITY) {
          await state.cast().commands()?.assign({ robotId: closest.id })
        }
      } else if (state.is(Done)) {
        await actyx.publish(myTag.applyTyped({ type: 'waterReceived' }))
        lastWatered = state.payload.when
        break
      }
    }
    currentRequest = undefined
    hasRequested = undefined
  }  

  // follow up on previously uncompleted request if any
  requestWater(false)

  let active = true
  cleanup.add(() => active = false)

  // the main loop for the plant
  while (active) {
    // first compute remaining water level and update UI
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

    if (waterLevel < 50 && !currentRequest) {
      // run the request for water in the background, it will eventually update lastWatered
      requestWater()
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * Passively follow the state of a plant.
 * 
 * @param actyx Actyx SDK instance
 * @param id name of the plant
 * @param stateCb callback to update the UI with the plant’s state
 * @param diedCb callback to call when the plant dies
 * @returns cleanup function to stop following the plant
 */
export const followPlant = (actyx: Actyx, id: string, stateCb: (_: PlantState) => void, diedCb: () => void) => {
  const myTag = PlantTag.withId(id)

  let interval: NodeJS.Timeout | null = null

  let pos: Pos = Position.random()
  let waterLevel = 100
  let mission: string | undefined = undefined

  const cancelAql = actyx.subscribeAql(`FROM ${myTag}`, (resp) => {
    // Actyx emits 'offsets' when transitioning from archive to live events
    if (resp.type === 'offsets') {
      interval = setInterval(() => stateCb({ pos, waterLevel, mission }), 300)
      return
    }

    if (resp.type !== 'event') return
    const { payload } = resp

    switch ((<{ type: string }>payload).type) {
      case 'created': {
        const created = Created.parse(payload)
        if (created.success) {
          pos = created.event.pos
        }
        break
      }
      
      case 'waterRequested': {
        const req = WaterRequested.parse(payload)
        if (req.success) {
          mission = req.event.reqId
        }
        break
      }
      
      case 'waterReceived': {
        const rec = WaterReceived.parse(payload)
        if (rec.success) {
          waterLevel = 100
          mission = undefined
        }
        break
      }
      
      case 'waterLevel': {
        const level = WaterLevel.parse(payload)
        if (level.success) {
          waterLevel = level.event.level
        }
        break
      }
      
      case 'died': {
        const died = Died.parse(payload)
        if (died.success) {
          diedCb()
          cancel()
        }
        break
      }
    }
  }, (err) => console.log('followPlant stopped due to error:', err))

  const cancel = () => {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    cancelAql()
  }

  return cancel
}
