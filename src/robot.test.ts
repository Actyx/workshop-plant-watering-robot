import { describe, expect, it } from '@jest/globals'
import { PROTOCOL } from './protocol'
import { RobotInitial, RobotMachine } from './robot'
import { PlantInitial, PlantMachine } from './plant'
import { checkProjection, checkSwarmProtocol } from '@actyx/machine-check'

describe('Robot', () => {
  it('should conform to the protocol', () => {
    const machine = RobotMachine.createJSONForAnalysis(RobotInitial)
    const plantSubscription = PlantMachine.createJSONForAnalysis(PlantInitial).subscriptions
    const subscriptions = {
      robot: machine.subscriptions,
      plant: plantSubscription,
    }

    expect(checkSwarmProtocol(PROTOCOL, subscriptions)).toEqual({ type: 'OK' })
    expect(checkProjection(PROTOCOL, subscriptions, 'robot', machine)).toEqual({ type: 'OK' })
  })
})

