import { MachineEvent, createMachineRunner } from "@actyx/machine-runner"
import { wateringProtocol, Event } from "./protocol"
import { Pos } from "./types"
import * as z from 'zod'
import { Actyx, Tag } from "@actyx/sdk"
import { Position } from "./position"
import { Cleanup, queryAql } from "./util"

/** The velocity of the robot in pixels per second. The size of the arena is 1000x1000 pixels. */
export const VELOCITY = 10

/**
 * Description of the robot’s machine: it shows the plant’s role in the swarm
 * protocol for watering.
 */

export const RobotMachine = wateringProtocol.makeMachine('robot')

export const RobotInitial = RobotMachine.designEmpty('initial')
  .finish()

const Requested = RobotMachine.designState('requested')
  .withPayload<{ plantId: string, plantPos: Pos, robots: string[] }>()
  .command('offer', [Event.Offer], (_ctx, x: Event.OfferPayloadType) => [x])
  .command('fail', [Event.Fail], (_ctx, x: Event.FailPayloadType) => [x])
  .finish()

const Assigned = RobotMachine.designState('assigned')
  .withPayload<{ plantId: string, plantPos: Pos, robotId: string }>()
  .command('start', [Event.Accept], (_ctx, x: Event.AcceptPayloadType) => [x])
  .finish()

const Moving = RobotMachine.designState('moving')
  .withPayload<{ plantId: string, plantPos: Pos, robotId: string, robotPos: Pos }>()
  .command('move', [Event.Move], (ctx, x: Event.MovePayloadType) => [
    ctx.withTags(['robot', `robot:${ctx.self.robotId}`], x)])
  .command('done', [Event.Finish], (_ctx, x: Event.FinishPayloadType) => [x])
  .command('fail3', [Event.Fail3], (_ctx, x: Event.Fail3PayloadType) => [x])
  .finish()

const Done = RobotMachine.designState('done').withPayload<{ robot: Pos }>().finish()

const Failed = RobotMachine.designEmpty('failed').finish()

const AllStates = [RobotInitial, Requested, Assigned, Moving, Done, Failed] as const

RobotInitial.react([Event.Request], Requested, (_ctx, { payload: { plantId, position } }) => (
  { plantId, plantPos: position, robots: [] }
))
Requested.react([Event.Offer], Requested, (ctx, ev) => {
  ctx.self.robots.push(ev.payload.robotId); return ctx.self
})
Requested.react([Event.Assign], Assigned, (ctx, ev) => ({
  plantId: ctx.self.plantId,
  plantPos: ctx.self.plantPos,
  robotId: ev.payload.robotId
}))
Requested.react([Event.Fail], Failed, () => ({}))
Assigned.react([Event.Accept], Moving, (ctx, ev) => (
  { ...ctx.self, robotPos: ev.payload.position }
))
Assigned.react([Event.Fail2], Failed, () => ({}))
Moving.reactIntoSelf([Event.Move], (ctx, ev) => {
  ctx.self.robotPos = ev.payload.position; return ctx.self
})
Moving.react([Event.Finish], Done, (ctx) => ({ robot: ctx.self.robotPos }))
Moving.react([Event.Fail3], Failed, () => ({}))

// 
// Besides interacting with the plants, the robot also has its own behaviour.
// 

/**
 * This is the state we’re sending to the UI for display.
 */
export type RobotState = {
  pos: Pos
  mission: string | undefined
}

// 
// Declaration of the event types emitted by the robot for its own purposes.
// 

const Created = MachineEvent.design('created').withZod(z.object({ pos: Pos }))
type Created = MachineEvent.Of<typeof Created>

const Mission = MachineEvent.design('mission').withZod(z.object({ mission: z.string() }))
type Mission = MachineEvent.Of<typeof Mission>

const Idle = MachineEvent.design('idle').withoutPayload()
type Idle = MachineEvent.Of<typeof Idle>

type AllEvents = Created | Mission | Idle

const CreateTag = Tag<Created>('robotCreated')
const MissionTag = Tag<Mission>('robotMission')
const RobotTag = Tag<AllEvents>('robot')

/**
 * This function runs a robot, finding requests for water and servicing them.
 * It should only be used to start the robot that is owned by the current app instance.
 * Other robots can be followed (passively) using `followRobot`.
 * 
 * @param actyx Actyx SDK instance
 * @param id name of the robot
 * @param stateCb callback to update the UI with the robot’s state
 * @param diedCb callback to call when the robot dies
 */
export const runRobot = async (actyx: Actyx, id: string, stateCb: (state: RobotState) => void, cleanup: Cleanup) => {
  // this is the basic set of tags for the robot ('robot' and 'robot:<id>')
  const myTag = RobotTag.withId(id)

  // get the last known position of the robot by first inspecting the creation event
  let pos = await (async () => {
    const p = (await queryAql<Pos>(actyx, `FROM ${myTag} & ${CreateTag} SELECT _.pos`)).at(0)?.payload

    // if there wasn’t yet a creation event, then emit it
    if (!p) {
      const pos = Position.random()
      await actyx.publish(myTag.and(CreateTag).applyTyped({ type: 'created', pos }))
      return pos
    } else {
      return p
    }
  })()

  // get the last known mission by looking at the last mission event, if any
  let mission = (await queryAql<string>(actyx, `PRAGMA features := aggregate
      FROM ${myTag} & ${MissionTag} AGGREGATE LAST(_.mission)`)).at(0)?.payload

  if (mission) {
    // get last known position from most recent mission
    const machine = createMachineRunner(actyx, myTag, RobotInitial, undefined).refineStateType(AllStates)
    for await (const state of machine) {
      if (state.is(RobotInitial)) {
        mission = undefined
      }
      const { payload } = state
      if (payload && 'robotPos' in payload) {
        pos = payload.robotPos
      }
      break // this automatically destroys the machine-runner instance
    }
  }

  let active = true
  cleanup.add(() => { active = false })

  /**
   * The main loop alternates between waiting for a mission and executing it.
   */
  while (active) {
    // console.log('state', { pos, mission })
    stateCb({ pos, mission })

    if (mission) {
      // we have a mission, let’s execute it
      let moving: NodeJS.Timeout | null = null
      let waitForAccept: NodeJS.Timeout | null = null
      
      const machine = createMachineRunner(actyx,
        wateringProtocol.tagWithEntityId(mission),
        RobotInitial, undefined
      ).refineStateType(AllStates)
      cleanup.add(() => machine.destroy())

      for await (const state of machine) {
        // console.log('mission', state)
        if (state.is(Requested)) {
          const s = state.cast()
          if (!s.payload.robots.includes(id)) {
            await s.commands()?.offer({ robotId: id, position: pos })
          } else {
            // set timeout to fail if no one accepts
            waitForAccept = setTimeout(() => s.commands()?.fail({ robotId: id }), 1000)
          }
          continue
        }
        if (waitForAccept) {
          // clear timeout when reaching a state other than Requested (which means further along in the protocol)
          clearTimeout(waitForAccept)
          waitForAccept = null
        }
        
        if (state.is(Assigned)) {
          const s = state.cast()
          if (s.payload.robotId === id) {
            // inform the plant
            await s.commands()?.start({ position: pos })
            // take note for self (think restart) and UI
            await actyx.publish(
              myTag.and(MissionTag).applyTyped({ type: 'mission', mission })
            )
          } else {
            // someone else got the mission, so we go back to picking a new one
            break
          }
        } else if (state.is(Moving)) {
          // start moving in the background, backing off if the mission changes
          if (moving === null) {
            moving = setInterval(async () => {
              const here = Position.fromPos(pos)
              const there = Position.fromPos(state.payload.plantPos)
              const direction = here.direction(there)

              // make sure we can emit a command to record the movement
              // (machine state can go stale due to network updates)
              const s = await machine.actual()
              if (s.done) throw new Error('machine destroyed')
              const s2 = s.value
              if (!s2.is(Moving)) return // can’t really happen

              if (direction.length() < 1) {
                // we have arrived at the plant and thus watered it
                s2.cast().commands()?.done({ plantId: s2.payload.plantId })
              } else if (direction.length() < VELOCITY) {
                // prevent overshooting when near the target
                pos = here.add(direction)
                s2.cast().commands()?.move({ position: pos })
              } else {
                // move towards the target at VELOCITY
                pos = here.add(direction.normalize().scale(VELOCITY))
                s2.cast().commands()?.move({ position: pos })
              }
              stateCb({ pos, mission })
            }, 300)
          }
        } else if (state.is(Done)) {
          await actyx.publish(myTag.applyTyped({ type: 'idle' }))
          break
        } else if (state.is(Failed)) {
          // abandon this process when nobody answered the offer
          break
        }
      }
      mission = undefined
      stateCb({ pos, mission })
      if (moving) {
        clearInterval(moving)
        moving = null
      }
    } else {
      // pick a new mission to bid on:
      // - first get all missions created within the last minute
      // - exclude those where the plant has died
      // - then go through them and start bidding on the first one that is still free
      // the query yields results in ascending lamport time order
      const missions = await queryAql<Event.RequestPayloadType>(actyx, `PRAGMA features := subQuery interpolation
        FROM 'wateringProtocol' & 'waterRequest' & TIME > 1m ago
        FILTER !IsDefined((FROM 'plant' & \`plant:{_.plantId}\` & 'lifecycle' ORDER DESC LIMIT 1 FILTER _.type = 'died')[0])
        `)

      for (const { meta } of missions) {
        // get the watering request ID from the protocol tag
        const m = meta.tags.filter((x) => x.startsWith('wateringProtocol:')).at(0)!.slice('wateringProtocol:'.length)

        // check if the mission is free; this is best done by running the protocol
        const machine = createMachineRunner(actyx, wateringProtocol.tagWithEntityId(m), RobotInitial, undefined)
        for await (const state of machine) {
          if (state.is(Requested)) {
            mission = m
          }
          break // we just need the first state that is emitted
        }
        if (mission) break
      }

      if (!mission) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
}

/**
 * Passively follow the state of a robot.
 * 
 * @param actyx Actyx SDK instance
 * @param id name of the robot
 * @param stateCb callback to update the UI with the robot’s state
 * @param diedCb callback to call when the robot dies
 * @returns cleanup function to stop following the robot
 */
export const followRobot = (actyx: Actyx, id: string, stateCb: (_: RobotState) => void) => {
  const myTag = RobotTag.withId(id)

  let interval: NodeJS.Timeout | null = null
  
  let pos: Pos = Position.random()
  let mission: string | undefined = undefined

  const cancelAql = actyx.subscribeAql(`FROM ${myTag}`, (resp) => {
    // Actyx emits 'offsets' when transitioning from archive to live events
    if (resp.type === 'offsets') {
      interval = setInterval(() => stateCb({ pos, mission }), 300)
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
      
      case 'mission': {
        const missionEv = Mission.parse(payload)
        if (missionEv.success) {
          mission = missionEv.event.mission
        }
        break
      }
      
      case 'idle': {
        const idle = Idle.parse(payload)
        if (idle.success) {
          mission = undefined
        }
        break
      }
      
      case 'move': {
        const moving = Event.Move.parse(payload)
        if (moving.success) {
          // console.log('moving', moving.event.position)
          pos = moving.event.position
        }
        break
      }
    }
  })

  return () => {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    cancelAql()
  }
}
