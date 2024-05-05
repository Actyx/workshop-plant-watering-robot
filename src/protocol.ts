import { SwarmProtocolType } from '@actyx/machine-check'
import { MachineEvent, SwarmProtocol } from '@actyx/machine-runner'
import * as z from 'zod'
import { Pos } from './types'

// protocol shape
export const PROTOCOL: SwarmProtocolType = {
  initial: 'initial',
  transitions: [
    { source: 'initial', target: 'requested', label: { cmd: 'request', logType: ['requested'], role: 'plant' } },
    { source: 'requested', target: 'requested', label: { cmd: 'offer', logType: ['offered'], role: 'robot' } },
    { source: 'requested', target: 'assigned', label: { cmd: 'assign', logType: ['assigned'], role: 'plant' } },
    { source: 'requested', target: 'failed', label: { cmd: 'fail', logType: ['failed'], role: 'robot' } },
    { source: 'assigned', target: 'moving', label: { cmd: 'start', logType: ['accepted'], role: 'robot' } },
    { source: 'moving', target: 'moving', label: { cmd: 'move', logType: ['moving'], role: 'robot' } },
    { source: 'moving', target: 'done', label: { cmd: 'done', logType: ['done'], role: 'robot' } },
  ]
}

// events
export namespace Event {
  export const RequestedPayload = z.object({ plantId: z.string(), position: Pos, reqId: z.string() })
  export type RequestedPayloadType = z.TypeOf<typeof RequestedPayload>
  export const Requested = MachineEvent.design('requested').withZod(RequestedPayload)
  
  export const OfferedPayload = z.object({ robotId: z.string() })
  export type OfferedPayloadType = z.TypeOf<typeof OfferedPayload>
  export const Offered = MachineEvent.design('offered').withZod(OfferedPayload)
  
  export const AssignedPayload = z.object({ robotId: z.string() })
  export type AssignedPayloadType = z.TypeOf<typeof AssignedPayload>
  export const Assigned = MachineEvent.design('assigned').withZod(AssignedPayload)
  
  export const AcceptedPayload = z.object({ position: Pos })
  export type AcceptedPayloadType = z.TypeOf<typeof AcceptedPayload>
  export const Accepted = MachineEvent.design('accepted').withZod(AcceptedPayload)
  
  export const MovingPayload = z.object({ position: Pos })
  export type MovingPayloadType = z.TypeOf<typeof MovingPayload>
  export const Moving = MachineEvent.design('moving').withZod(MovingPayload)
  
  export const DonePayload = z.object({ plantId: z.string() })
  export type DonePayloadType = z.TypeOf<typeof DonePayload>
  export const Done = MachineEvent.design('done').withZod(DonePayload)

  export const FailedPayload = z.object({ robotId: z.string() })
  export type FailedPayloadType = z.TypeOf<typeof FailedPayload>
  export const Failed = MachineEvent.design('failed').withZod(FailedPayload)
  
  export const All = [Requested, Offered, Assigned, Accepted, Moving, Done, Failed] as const
}

// protocol declaration
export const wateringProtocol = SwarmProtocol.make('wateringProtocol', Event.All)


