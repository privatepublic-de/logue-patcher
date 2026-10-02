import type { AxolotiIpcApi } from '../shared/ipc/contract'

declare global {
  interface Window {
    axoloti: AxolotiIpcApi
  }
}
