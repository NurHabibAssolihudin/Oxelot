export { DaemonBridge } from './bridge'
export type { DaemonBridgeOptions } from './bridge'
export { DaemonConnection } from './connection'
export { nextBackoffDelay } from './connection'
export type {
  DaemonState,
  DaemonSocket,
  DaemonTransportFactory,
  DaemonTransportHandlers,
  DaemonBackoff,
  DaemonConnectionOptions,
} from './types'
export { parseDaemonMessage, toDaemonErrorCode, DAEMON_PROTOCOL_VERSION } from './schema'
export type {
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
} from './schema'
export { wsFactory, rtcFactory } from './transport'
export { GrantGate } from './grant'
export type { GestureSource, GrantGateOptions } from './grant'
export { DAEMON_REGISTRY, describeCapability, encodeBytes, decodeBytes } from './registry'
export type {
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
} from './registry'
