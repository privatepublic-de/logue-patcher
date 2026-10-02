import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '@shared/ipc/contract'

describe('IPC_CHANNELS', () => {
  it('namespaces every channel under axoloti: so it cannot collide with electron-toolkit internals', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel.startsWith('axoloti:')).toBe(true)
    }
  })
})

describe('IPC_EVENT_CHANNELS', () => {
  it('namespaces every push-event channel under axoloti: too, distinct from request/response channels', () => {
    const requestChannels = new Set(Object.values(IPC_CHANNELS))
    for (const channel of Object.values(IPC_EVENT_CHANNELS)) {
      expect(channel.startsWith('axoloti:')).toBe(true)
      expect(requestChannels.has(channel as (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS])).toBe(
        false
      )
    }
  })
})
