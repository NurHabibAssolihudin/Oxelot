export { Oxelot } from './core/index'
export type { OxelotConfig, SyncConfig, StorageFacade } from './core/index'
export type { OxelotEvent, DatabaseFacade } from './core/types'
export type { StorageBackend, StorageProvider, OxelotFile } from './core/storage'
export type { HardwareBridge, HardwareCapabilities, HardwareCapability } from './core/hardware'
export type { SyncService, OxelotMutation, SyncState } from './core/sync'
export { makeStorageMutation, newMutationId, storageCollection } from './core/sync'
export type { StorageMutationOptions } from './core/sync'
export { OxelotError } from './errors'
export type { OxelotErrorCode } from './errors'
export { DaemonBridge, DaemonConnection, nextBackoffDelay, parseDaemonMessage, toDaemonErrorCode, DAEMON_PROTOCOL_VERSION } from './core/daemon'
export { GrantGate, DAEMON_REGISTRY, describeCapability, encodeBytes, decodeBytes } from './core/daemon'
export type {
  DaemonBridgeOptions,
  DaemonState,
  DaemonSocket,
  DaemonTransportFactory,
  DaemonTransportHandlers,
  DaemonBackoff,
  DaemonConnectionOptions,
  CapabilityAdvertisement,
  DaemonHello,
  DaemonAdvertise,
  DaemonRequest,
  DaemonResponse,
  DaemonResponseOk,
  DaemonResponseError,
  DaemonEvent,
  DaemonPing,
  DaemonPong,
  DaemonMessage,
  GestureSource,
  GrantGateOptions,
  CapabilityDescriptor,
  SerialPortInfo,
  SerialOpenResult,
  SerialReadResult,
  SocketConnectResult,
  SystemStats,
  DaemonSerialApi,
  DaemonSocketApi,
  DaemonFileApi,
  DaemonSysApi,
} from './core/daemon'
