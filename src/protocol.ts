import { SwarmProtocolType } from '@actyx/machine-check'
import { MachineEvent, SwarmProtocol } from '@actyx/machine-runner'
import * as z from 'zod'
import { Pos } from './types'

// protocol shape
export const PROTOCOL: SwarmProtocolType = {
  initial: 'initial',
  transitions: [
    { source: 'initial', target: 'requested', label: { cmd: 'request', logType: ['request'], role: 'plant' } },
    { source: 'requested', target: 'requested', label: { cmd: 'offer', logType: ['offer'], role: 'robot' } },
    { source: 'requested', target: 'assigned', label: { cmd: 'assign', logType: ['assign'], role: 'plant' } },
    { source: 'requested', target: 'failed', label: { cmd: 'fail', logType: ['fail'], role: 'robot' } },
    { source: 'assigned', target: 'moving', label: { cmd: 'start', logType: ['accept'], role: 'robot' } },
    { source: 'assigned', target: 'failed', label: { cmd: 'fail2', logType: ['fail2'], role: 'plant' } },
    { source: 'moving', target: 'moving', label: { cmd: 'move', logType: ['move'], role: 'robot' } },
    { source: 'moving', target: 'done', label: { cmd: 'done', logType: ['finish'], role: 'robot' } },
    { source: 'moving', target: 'failed', label: { cmd: 'fail3', logType: ['fail3'], role: 'robot' } },
  ]
}

// events
export namespace Event {
  export const RequestPayload = z.object({ plantId: z.string(), position: Pos, reqId: z.string() })
  export type RequestPayloadType = z.TypeOf<typeof RequestPayload>
  export const Request = MachineEvent.design('request').withZod(RequestPayload)
  
  export const OfferPayload = z.object({ robotId: z.string(), position: Pos })
  export type OfferPayloadType = z.TypeOf<typeof OfferPayload>
  export const Offer = MachineEvent.design('offer').withZod(OfferPayload)
  
  export const AssignPayload = z.object({ robotId: z.string() })
  export type AssignPayloadType = z.TypeOf<typeof AssignPayload>
  export const Assign = MachineEvent.design('assign').withZod(AssignPayload)
  
  export const AcceptPayload = z.object({ position: Pos })
  export type AcceptPayloadType = z.TypeOf<typeof AcceptPayload>
  export const Accept = MachineEvent.design('accept').withZod(AcceptPayload)
  
  export const MovePayload = z.object({ position: Pos })
  export type MovePayloadType = z.TypeOf<typeof MovePayload>
  export const Move = MachineEvent.design('move').withZod(MovePayload)
  
  export const FinishPayload = z.object({ plantId: z.string() })
  export type FinishPayloadType = z.TypeOf<typeof FinishPayload>
  export const Finish = MachineEvent.design('finish').withZod(FinishPayload)

  export const FailPayload = z.object({ robotId: z.string() })
  export type FailPayloadType = z.TypeOf<typeof FailPayload>
  export const Fail = MachineEvent.design('fail').withZod(FailPayload)

  export const Fail2Payload = z.object({ robotId: z.string() })
  export type Fail2PayloadType = z.TypeOf<typeof Fail2Payload>
  export const Fail2 = MachineEvent.design('fail2').withZod(Fail2Payload)

  export const Fail3Payload = z.object({ robotId: z.string() })
  export type Fail3PayloadType = z.TypeOf<typeof Fail3Payload>
  export const Fail3 = MachineEvent.design('fail3').withZod(Fail3Payload)
  
  export const All = [Request, Offer, Assign, Accept, Move, Finish, Fail, Fail2, Fail3] as const
}

// protocol declaration
export const wateringProtocol = SwarmProtocol.make('wateringProtocol', Event.All)


