/**
 * G2 dataset helpers (Chapter 8 §8.4.2). Generates a deterministic byte pattern
 * and verifies byte-exact round-trips through the Oxelot file facade. Used by
 * the 5MB CI smoke (`opfs` tag) and the 500MB manual soak (`@g2-full`).
 */
import type { OxelotLike } from './oxelot-like'

/** Deterministic pseudo-random byte for a given offset, so we can verify without storing expected data. */
export function patternByte(offset: number): number {
  return (offset * 131 + (offset >> 8) * 29 + 7) & 0xff
}

export async function writePattern(
  file: { writeBytes(offset: number, data: Uint8Array): Promise<void>; sync(): Promise<void> },
  size: number,
  chunkSize = 1 << 20,
): Promise<void> {
  const chunk = new Uint8Array(chunkSize)
  for (let offset = 0; offset < size; offset += chunkSize) {
    const len = Math.min(chunkSize, size - offset)
    for (let i = 0; i < len; i++) chunk[i] = patternByte(offset + i)
    await file.writeBytes(offset, chunk.subarray(0, len))
  }
  await file.sync()
}

export async function verifyPattern(
  file: { readBytes(offset: number, length: number): Promise<Uint8Array> },
  size: number,
  chunkSize = 1 << 20,
): Promise<void> {
  let offset = 0
  while (offset < size) {
    const len = Math.min(chunkSize, size - offset)
    const data = await file.readBytes(offset, len)
    if (data.length !== len) {
      throw new Error(`G2: short read at ${offset}: expected ${len}, got ${data.length}`)
    }
    for (let i = 0; i < len; i++) {
      if (data[i] !== patternByte(offset + i)) {
        throw new Error(`G2: byte mismatch at ${offset + i}: expected ${patternByte(offset + i)}, got ${data[i]}`)
      }
    }
    offset += len
  }
}

export async function opfsSoak(oxelot: OxelotLike, name: string, size: number): Promise<void> {
  const file = await oxelot.storage.open(name)
  await writePattern(file, size)
  await file.close()

  const got = await oxelot.storage.open(name)
  const actualSize = await got.size()
  if (actualSize !== size) throw new Error(`G2: size mismatch: expected ${size}, got ${actualSize}`)
  await verifyPattern(got, size)
  await got.close()

  await oxelot.storage.remove(name)
}
