import { MachineEvent, createMachineRunner } from "@actyx/machine-runner"
import { protocol, Event } from "./protocol"
import { Pos } from "./types"
import * as z from 'zod'
import { Actyx, Tag } from "@actyx/sdk"
import { Position } from "./position"
import { queryAql } from "./util"

const VELOCITY = 10

/**
 * Description of the plant’s machine: it shows the plant’s role in the swarm
 * protocol for watering.
 */

const RobotMachine = protocol.makeMachine('robot')

const Initial = RobotMachine.designEmpty('initial')
  .finish()

const Requested = RobotMachine.designState('requested')
  .withPayload<{ plantId: string, plantPos: Pos, robots: string[] }>()
  .command('offer', [Event.Offered], (_ctx, x: Event.OfferedPayloadType) => [x])
  .command('fail', [Event.Failed], (_ctx, x: Event.FailedPayloadType) => [x])
  .finish()

const Assigned = RobotMachine.designState('assigned')
  .withPayload<{  plantId: string, plantPos: Pos, robotId: string }>()
  .command('accept', [Event.Accepted], (_ctx, x: Event.AcceptedPayloadType) => [x])
  .finish()

const Moving = RobotMachine.designState('moving')
  .withPayload<{ plantId: string, plantPos: Pos, robotId: string, robot: Pos }>()
  .command('move', [Event.Moving], (ctx, x: Event.MovingPayloadType) => [ctx.withTags(['robot', `robot:${ctx.self.robotId}`], x)])
  .command('done', [Event.Done], (_ctx, x: Event.DonePayloadType) => [x])
  .finish()

const Done = RobotMachine.designState('done').withPayload<{ robot: Pos }>().finish()
const Failed = RobotMachine.designEmpty('failed').finish()

const AllStates = [Initial, Requested, Assigned, Moving, Done, Failed] as const

Initial.react([Event.Requested], Requested, (_ctx, { payload: { plantId, position } }) => ({ plantId, plantPos: position, robots: [] }))
Requested.react([Event.Offered], Requested, (ctx, ev) => { ctx.self.robots.push(ev.payload.robotId); return ctx.self })
Requested.react([Event.Assigned], Assigned, (ctx, ev) => ({ plantId: ctx.self.plantId, plantPos: ctx.self.plantPos, robotId: ev.payload.robotId }))
Requested.react([Event.Failed], Failed, () => ({ }))
Assigned.react([Event.Accepted], Moving, (ctx, ev) => ({ ...ctx.self, robot: ev.payload.position }))
Moving.reactIntoSelf([Event.Moving], (ctx, ev) => { ctx.self.robot = ev.payload.position; return ctx.self })
Moving.react([Event.Done], Done, (ctx) => ({ robot: ctx.self.robot }))

export type RobotState = {
  pos: Pos
  mission: string | undefined
}

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

export const runRobot = async (actyx: Actyx, id: string, stateCb: (state: RobotState) => void) => {
  const myTag = RobotTag.withId(id)

  let pos = (await queryAql<Pos>(actyx, `FROM ${myTag} & ${CreateTag} SELECT _.pos`)).at(0)?.payload

  if (!pos) {
    pos = Position.random()
    await actyx.publish(myTag.and(CreateTag).applyTyped({ type: 'created', pos }))
  }

  let mission = (await queryAql<string>(actyx, `PRAGMA features := aggregate
      FROM ${myTag} & ${MissionTag} AGGREGATE LAST(_.mission)`)).at(0)?.payload

  if (mission) {
    // get last known position from most recent mission
    const machine = createMachineRunner(actyx, myTag, Initial, undefined).refineStateType(AllStates)
    for await (const { payload } of machine) {
      if (payload && 'robot' in payload) {
        pos = payload.robot
      }
      break
    }
  }

  /**
   * The main loop alternates between waiting for a mission and executing it.
   */
  for (;;) {
    stateCb({ pos, mission })

    if (mission) {
      const machine = createMachineRunner(actyx, protocol.tagWithEntityId(mission), Initial, undefined).refineStateType(AllStates)
      let interval: NodeJS.Timeout | null = null
      let timeout: NodeJS.Timeout | null = null
      for await (const state of machine) {
        // console.log('robot', id, 'mission', mission, 'state', state)
        if (state.is(Requested)) {
          const s = state.cast()
          if (!s.payload.robots.includes(id)) {
            await s.commands()?.offer({ robotId: id })
          } else {
            // set timeout to fail if no one accepts
            timeout = setTimeout(() => s.commands()?.fail({ robotId: id }), 1000)
          }
          continue
        }
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        
        if (state.is(Assigned)) {
          const s = state.cast()
          if (s.payload.robotId === id) {
            await s.commands()?.accept({ position: pos })
            await actyx.publish(myTag.and(MissionTag).applyTyped({ type: 'mission', mission }))
          } else {
            break
          }
        } else if (state.is(Moving)) {
          // start moving in the background, backing off if the mission changes
          if (interval === null) {
            interval = setInterval(async () => {
              const here = Position.fromPos(pos!)
              const there = Position.fromPos(state.payload.plantPos)
              const direction = here.direction(there)

              // make sure we can emit a command to record the movement
              const s = await machine.actual()
              if (s.done) throw new Error('machine destroyed')
              const s2 = s.value
              if (!s2.is(Moving)) return

              if (direction.length() < 1) {
                // we have arrived at the plant and thus watered it
                s2.cast().commands()?.done({ plantId: s2.payload.plantId })
              } else if (direction.length() < VELOCITY) {
                pos = here.add(direction)
                s2.cast().commands()?.move({ position: pos })
              } else {
                pos = here.add(direction.normalize().scale(VELOCITY))
                s2.cast().commands()?.move({ position: pos })
              }
              stateCb({ pos: pos!, mission })
            }, 300)
          }
        } else if (state.is(Done)) {
          await actyx.publish(myTag.applyTyped({ type: 'idle' }))
          break
        } else if (state.is(Failed)) {
          break
        }
      }
      mission = undefined
      stateCb({ pos, mission })
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    } else {
      // pick a new mission to bid on:
      // - first get all missions created within the last minute
      // - then go through them and start bidding on the first one that is still free
      // the query yields results in ascending lamport time order
      const missions = await queryAql<Event.RequestedPayloadType>(actyx, `PRAGMA features := subQuery interpolation
        FROM 'wateringProtocol' & 'waterRequest' & TIME > 1m ago
        FILTER !IsDefined((FROM 'plant' & \`plant:{_.plantId}\` & 'lifecycle' ORDER DESC LIMIT 1 FILTER _.type = 'died')[0])
        `)

      for (const { meta } of missions) {
        const m = meta.tags.filter((x) => x.startsWith('wateringProtocol:')).at(0)!.slice('wateringProtocol:'.length)
        const machine = createMachineRunner(actyx, protocol.tagWithEntityId(m), Initial, undefined)
        for await (const state of machine) {
          if (state.is(Requested)) {
            mission = m
          }
          break
        }
        if (mission) break
      }

      if (!mission) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
}

export const followRobot = (actyx: Actyx, id: string, stateCb: (_: RobotState) => void) => {
  const myTag = RobotTag.withId(id)

  let interval: NodeJS.Timeout | null = null
  
  let pos: Pos = Position.random()
  let mission: string | undefined = undefined

  console.log('follow robot', id)

  const cancelAql = actyx.subscribeAql(`FROM ${myTag}`, (resp) => {
    if (resp.type === 'offsets') {
      interval = setInterval(() => stateCb({ pos, mission }), 300)
      return
    }
    if (resp.type !== 'event') return
    const { payload } = resp

    console.log('robot', id, 'event', payload)

    const created = Created.parse(payload)
    if (created.success) {
      pos = created.event.pos
    }

    const missionEv = Mission.parse(payload)
    if (missionEv.success) {
      mission = missionEv.event.mission
    }

    const idle = Idle.parse(payload)
    if (idle.success) {
      mission = undefined
    }

    const moving = Event.Moving.parse(payload)
    if (moving.success) {
      console.log('moving', moving.event.position)
      pos = moving.event.position
    }
  })

  return () => {
    console.log('cancel robot', id)
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    cancelAql()
  }
}
