import type { OxelotPool } from './pool/pool'
import type { DatabaseFacade } from './types'
import { oxError } from '../errors'

export class PooledDatabase implements DatabaseFacade {
  constructor(
    private readonly pool: OxelotPool,
    private readonly dbName: string,
    private readonly enabled = true,
  ) {}

  private ensureEnabled(): void {
    if (!this.enabled) throw oxError('ERR_DB_DISABLED', 'SQLite sub-facade is disabled (dbEnabled: false)')
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.ensureEnabled()
    await this.pool.request('db.run', { sql, paramsJson: JSON.stringify(params) })
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.ensureEnabled()
    const rows = await this.pool.request<T[]>('db.query', { sql, paramsJson: JSON.stringify(params) })
    return rows
  }

  async exec<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async checkpoint(): Promise<void> {
    await this.run(`PRAGMA wal_checkpoint(TRUNCATE);`)
  }
}
