//! Thin FFI boundary: raw-pointer reads, allocation, and SQLite's
//! serialize/deserialize round-trip. The crate denies `unsafe_code`
//! everywhere else; this module is the single sanctioned exception.

use rusqlite::serialize::OwnedData;
use rusqlite::{Connection, MAIN_DB, Result as SqliteResult};
use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};
use std::ptr::{self, NonNull};

/// Allocate `len` bytes in wasm linear memory (or the host heap in tests).
pub fn alloc_bytes(len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let layout = Layout::array::<u8>(len as usize).expect("valid layout");
    unsafe { raw_alloc(layout) as usize }
}

/// Free a buffer previously returned by `alloc_bytes`.
pub fn free_bytes(ptr: usize, len: usize) {
    if ptr == 0 {
        return;
    }
    let layout = Layout::array::<u8>(len as usize).expect("valid layout");
    unsafe { raw_dealloc(ptr as *mut u8, layout) }
}

/// Copy `len` bytes from linear memory `[ptr, ptr+len)` into an owned Vec.
pub fn read_bytes(ptr: usize, len: usize) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }.to_vec()
}

/// Deserialize a DB image (bytes previously produced by `serialize_from`) into
/// `conn`, replacing its contents. `conn` must be freshly opened.
pub fn deserialize_into(conn: Connection, bytes: Vec<u8>) -> Result<Connection, String> {
    if bytes.is_empty() {
        return Ok(conn);
    }
    let mut conn = conn;
    let rc = unsafe {
        let buf =
            rusqlite::ffi::sqlite3_malloc64(bytes.len() as rusqlite::ffi::sqlite3_uint64)
                as *mut u8;
        if buf.is_null() {
            return Err("sqlite3_malloc64 failed".to_string());
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), buf, bytes.len());
        let data = OwnedData::from_raw_nonnull(NonNull::new_unchecked(buf), bytes.len());
        conn.deserialize(MAIN_DB, data, false)
    };
    rc.map(|_| conn).map_err(|e| e.to_string())
}

/// Serialize the whole main database into an owned byte image.
pub fn serialize_from(conn: &Connection) -> SqliteResult<Vec<u8>> {
    Ok(conn.serialize(MAIN_DB)?.to_vec())
}
