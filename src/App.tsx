import { Actyx } from "@actyx/sdk"
import { useEffect, useState } from "react"
import { PlantState, followPlant, runPlant } from "./plant"
import { RobotState, followRobot, runRobot } from "./robot"
import * as UUID from 'uuid'
import { Position } from "./position"
import { deepEqual } from "fast-equals"
import { cleanup } from "./util"

/**
 * Subscribe to Actyx event streams and detect when IDs for a given tag are newly detected or
 * inactive for a while (i.e. removed).
 * 
 * This is used to detect new plants and robots in the system.
 * 
 * @param actyx Actyx SDK instance
 * @param tag the event tag to search for
 * @param addCb callback when a new ID is found
 * @param delCb callback when an ID is removed
 */
const findIds = (actyx: Actyx, tag: string, addCb: (_: string) => void, delCb: (_: string) => void): (() => void) => {
  // Map of plant IDs to the last time they were seen
  const set = new Map<string, Date>()

  // Check every second if a plant has been inactive for more than a minute and remove it if so
  const interval = setInterval(() => {
    const toRemove: string[] = []
    const now = new Date()
    for (const [plant, timestamp] of set) {
      if (now.getTime() - timestamp.getTime() > 60_000) toRemove.push(plant)
    }
    for (const plant of toRemove) {
      set.delete(plant)
      delCb(plant)
    }
  }, 1000)

  // Subscribe to the event stream for the given tag, extract the ID from the event tags and add it to the set
  const tagIdStart = `${tag}:`
  const cancelSub = actyx.subscribeAql(`FROM "${tag}" & TIME > 1m ago`, (resp) => {
    if (resp.type !== 'event') return
    const id = resp.meta.tags.filter(x => x.startsWith(tagIdStart))[0].slice(tagIdStart.length)
    if (!set.has(id)) {
      addCb(id)
    }
    set.set(id, resp.meta.timestampAsDate())
  }, (err) => console.log('findPlants stopped due to error:', err))

  return () => {
    clearInterval(interval)
    cancelSub()
  }
}

const findPlants = (actyx: Actyx, addCb: (_: string) => void, delCb: (_: string) => void) => findIds(actyx, 'plant', addCb, delCb)
const findRobots = (actyx: Actyx, addCb: (_: string) => void, delCb: (_: string) => void) => findIds(actyx, 'robot', addCb, delCb)

/**
 * Helper type for wrapping plant or robot states with additional management information.
 */
type Mgmt<T> =
  | { type: 'fresh', id: string, cancel: () => void }
  | { type: 'ready', id: string, cancel: () => void, state: T }

/**
 * Add a new plant or robot to the list of managed states.
 * This will start the state management function and update the list of managed states.
 * It is important to note that usage of the `setter` function submits a closure to
 * React, which will call this function whenever it pleases (usually many times!).
 * Also note that React doesn’t like too many re-renders, so only construct a new array
 * if the state has actually changed.
 * 
 * @param actyx Actyx SDK instance
 * @param setter React state update function for the list of managed states
 * @param id ID of the plant or robot to be added
 * @param factory constructor for the function that will manage the state of this plant or robot
 */
const add = <T extends Record<string, unknown>>(actyx: Actyx, setter: (_: (_: Mgmt<T>[]) => Mgmt<T>[]) => void, id: string,
    factory: (_: Actyx, id: string, state: (_: T) => void, died: () => void) => ((() => void) | Promise<void>)) => {
  console.log('adding', id)

  // start running or following a plant or robot
  const res = factory(actyx, id, (state) => {
    setter((set) =>
      deepEqual(state, set.find(x => x.id === id))
        ? set : set.map(x => x.id === id ? { ...x, type: 'ready', state }
        : x))
  }, () => del(setter, id))

  const cancel = res instanceof Promise ? () => {} : res
  const state = { type: 'fresh' as const, cancel, id }

  // ensure that the state is already in the list when the factory uses the setter
  setter(set => [...set, state])
}

/**
 * Remove a plant or robot from the list of managed states.
 * This submits the corresponding change logic to React, which will call the provided
 * function whenever it pleases (usually many times!).
 * 
 * @param setter React state update function for the list of managed states
 * @param id ID of the plant or robot to be removed
 */
const del = <T extends Record<string, unknown>>(setter: (_: (_: Mgmt<T>[]) => Mgmt<T>[]) => void, id: string) => setter((set) => {
  const idx = set.findIndex(x => x.id === id)
  if (idx < 0) return set
  console.log('removing', id)
  const next = [...set]
  next.splice(idx, 1)[0].cancel()
  return next
})

type Props = { actyx: Actyx }

/**
 * Request a persistent ID for a given key.
 * If the ID is not yet stored in localStorage, a new UUID is generated and stored.
 * 
 * @param key name of the localStorage item to use
 * @returns persistent ID from localStorage or a new UUID
 */
const persistentId = (key: string) => {
  const l = localStorage.getItem(key)
  if (l) return l
  const id = UUID.v4()
  localStorage.setItem(key, id)
  return id
}

export const App = ({ actyx }: Props) => {
  let effectHasRun = false

  const [plantId, setPlantId] = useState('')
  const [robotId, setRobotId] = useState('')

  // all effects need to go in here, because useState setters are run many times
  useEffect(() => {
    // React is weird
    if (effectHasRun) return
    // eslint-disable-next-line react-hooks/exhaustive-deps
    else effectHasRun = true
    if (plants.length > 0 || robots.length > 0) {
      // this happens via hot reload
      console.log('handling hot-reload')
      setPlants(plants => {
        plants.forEach(plant => plant.cancel())
        return []
      })
      setRobots(robots => {
        robots.forEach(robot => robot.cancel())
        return []
      })
    }

    const clean = cleanup()

    let myPlant = persistentId('plantId')
    const myRobot = persistentId('robotId')
    console.log('starting: plant', myPlant, 'robot', myRobot)

    const restart = (died: boolean) => {
      if (died) {
        console.log('plant died', myPlant)
        localStorage.removeItem('plantId')
        myPlant = persistentId('plantId')
        console.log('restarting: plant', myPlant)
      }
      setPlantId(myPlant)
      runPlant(actyx, myPlant, () => {}, () => restart(true), clean)
    }
    restart(false)

    runRobot(actyx, myRobot, () => {}, clean)
    setRobotId(myRobot)

    // start listening to events from plants and robots to update their lists (and thus the UI)
    clean.add(findPlants(actyx, (id) => add(actyx, setPlants, id, followPlant), (id) => del(setPlants, id)))
    clean.add(findRobots(actyx, (id) => add(actyx, setRobots, id, followRobot), (id) => del(setRobots, id)))

    return clean.clean
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actyx])

  const [plants, setPlants] = useState<Mgmt<PlantState>[]>([])
  const [robots, setRobots] = useState<Mgmt<RobotState>[]>([])
  
  return (
    <div>
      <h1>Plants</h1>
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Position</th>
            <th>Water Level</th>
            <th>Mission</th>
          </tr>
        </thead>
        <tbody>
          {plants.map((plant) => plant.type === 'ready' && (
            <tr key={plant.id}>
              <td>{plant.id} {plant.id === plantId ? '*' : undefined}</td>
              <td>{Position.fromPos(plant.state.pos).toString()}</td>
              <td>{plant.state.waterLevel.toFixed(0)}</td>
              <td>{plant.state.mission}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h1>Robots</h1>
      <table>
        <thead>
          <tr>
            <th>Id</th>
            <th>Position</th>
            <th>Mission</th>
          </tr>
        </thead>
        <tbody>
          {robots.map((robot) => robot.type === 'ready' && (
            <tr key={robot.id}>
              <td>{robot.id} {robot.id === robotId ? '*' : undefined}</td>
              <td>{Position.fromPos(robot.state.pos).toString()}</td>
              <td>{robot.state.mission}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
