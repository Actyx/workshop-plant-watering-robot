import { Actyx } from "@actyx/sdk"
import { useEffect, useRef, useState } from "react"
import { PlantState, followPlant, runPlant } from "./plant"
import { RobotState, followRobot, runRobot } from "./robot"
import * as UUID from 'uuid'
import { Position } from "./position"
import { cleanup, mpmc } from "./util"

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
const findIds = (actyx: Actyx, tag: string, addCb: (_: string) => void, delCb: (_: string) => void) => {
  // Map of plant IDs to the last time they were seen
  const set = new Map<string, Date>()

  // Check every second if a plant has been inactive for more than a minute and remove it if so
  const gc = setInterval(() => {
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
  const unsub = actyx.subscribeAql(`FROM "${tag}" & TIME > 1m ago`, (resp) => {
    if (resp.type !== 'event') return
    const id = resp.meta.tags.filter(x => x.startsWith(tagIdStart))[0].slice(tagIdStart.length)
    if (!set.has(id)) {
      addCb(id)
    }
    set.set(id, resp.meta.timestampAsDate())
  }, (err) => console.log('findPlants stopped due to error:', err))

  return () => {
    clearInterval(gc)
    unsub()
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
 * @param map React state update function for the list of managed states
 * @param id ID of the plant or robot to be added
 * @param factory constructor for the function that will manage the state of this plant or robot
 */
const add = <T extends Record<string, unknown>>(actyx: Actyx, sync: () => unknown, map: Map<string, Mgmt<T>>, id: string,
    factory: (_: Actyx, id: string, state: (_: T) => void, died: () => void) => ((() => void))) => {
  if (map.has(id)) return;
  console.log('adding', id)

  // start running or following a plant or robot
  const res = factory(actyx, id, (state) => {
    const old = map.get(id);
    if (!old) return
    const readyState = { ...old, type: 'ready' as const, state };
    map.set(id, readyState);
    sync()
  }, () => del(sync, map, id))

  const state = { type: 'fresh' as const, cancel: res, id }

  map.set(id, state);
  sync()

  return res
}

/**
 * Remove a plant or robot from the list of managed states.
 * This submits the corresponding change logic to React, which will call the provided
 * function whenever it pleases (usually many times!).
 * 
 * @param map React state update function for the list of managed states
 * @param id ID of the plant or robot to be removed
 */
const del = <T extends Record<string, unknown>>(sync: () => unknown, map: Map<string, Mgmt<T>>, id: string) => {
  map.delete(id)
  sync()
}

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

  const plants = useRef<Map<string, Mgmt<PlantState>>>(new Map())
  const robots = useRef<Map<string, Mgmt<RobotState>>>(new Map())

  const [plantId, setPlantId] = useState('')
  const [robotId, setRobotId] = useState('')

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_, setRefreshSymbol] = useState(Symbol())

  useEffect(() => {
    let alive = true;
    const isAlive = () => alive
    const sync = mpmc<void>();
    sync.sub(() => setRefreshSymbol(Symbol()))
    const clean = cleanup();

    let myPlant = persistentId('plantId')
    const myRobot = persistentId('robotId')
    setRobotId(myRobot)
    setPlantId(myPlant)
    console.log('starting: plant', myPlant, 'robot', myRobot)

    const restart = (died: boolean) => {
      if (died) {
        console.log('plant died', myPlant)
        localStorage.removeItem('plantId')
        myPlant = persistentId('plantId')
        console.log('restarting: plant', myPlant)
      }
      runPlant(isAlive, actyx, myPlant, () => {}, () => restart(true))
    }
    restart(false)

    runRobot(isAlive, actyx, myRobot, () => {})

    // start listening to events from plants and robots to update their lists (and thus the UI)
    const unsubPlant = findPlants(actyx, (id) => {
      const unsub = add(actyx, sync.emit, plants.current, id, followPlant)
      if (!unsub) return
      clean.add(unsubPlant)
    }, (id) => del(sync.emit, plants.current, id))

    const unsubRobot = findRobots(actyx, (id) => {
      const unsub = add(actyx, sync.emit, robots.current, id, followRobot)
      if (!unsub) return
      clean.add(unsub)
    }, (id) => del(sync.emit, robots.current, id))

    clean.add(unsubPlant)
    clean.add(unsubRobot)

    sync.emit()

    return () => {
      alive = false;
      clean.clean()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actyx])
  
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
          {Array.from(plants.current.values()).map((plant) => plant.type === 'ready' && (
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
          {Array.from(robots.current.values()).map((robot) => robot.type === 'ready' && (
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
