//! Oxelot SQLite WASM module.
//!
//! Target: `wasm32-wasip1`. Persistence is delivered by serializing the whole
//! main database image on every mutation and handing the bytes to the JS glue,
//! which stores them in OPFS (`StorageFacade.open(dbName)`). On init the image
//! is deserialized back. This is the interim strategy documented in ADR-05;
//! the long-term target is a byte-level OPFS VFS.
//!
//! The module exposes a plain `extern "C"` ABI (no wasm-bindgen) so the JS
//! loader can instantiate it with a small WASI shim:
//!   - `alloc(len) -> ptr`, `dealloc(ptr, len)` — input buffers for JS
//!   - `init(db_ptr, db_len) -> i32`  — open + optionally load a DB image
//!   - `run(sql_ptr, sql_len, params_ptr, params_len) -> i32`
//!   - `query(sql_ptr, sql_len, params_ptr, params_len) -> i32`
//!   - `export_db() -> i32`           — serialize the main DB into the result
//!   - `result_ptr() -> usize`, `result_len() -> usize` — read the result buffer
//!   - errors: non-zero return; message available via `result_*`.
//!
//! Building:
//!   rustup target add wasm32-wasip1
//!   cargo build --target wasm32-wasip1 --release
//!   # C compiler: zig via `.cargo/config.toml` (CC_wasm32_wasip1 = zigcc;
//!   # libsqlite3-sys 0.38 auto-applies the wasm C flags for `wasm32-wasi*`).
#![deny(unsafe_code)]

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, params_from_iter};
use std::sync::Mutex;

// SQLite's bundled allocator maps to the C `malloc` from wasi-libc. Rust's
// default wasm allocator (dlmalloc) would maintain a second, independent heap
// on the same linear memory and corrupt C allocations. Routing Rust through
// the libc allocator keeps a single heap. (Host builds already use System.)
#[global_allocator]
static ALLOCATOR: std::alloc::System = std::alloc::System;

#[allow(unsafe_code)]
mod ffi;

static DB: Mutex<Option<Connection>> = Mutex::new(None);
static RESULT: Mutex<Option<Vec<u8>>> = Mutex::new(None);

fn set_result(bytes: Vec<u8>) {
    *RESULT.lock().unwrap() = Some(bytes);
}

fn set_error(err: impl std::fmt::Display) -> i32 {
    set_result(err.to_string().into_bytes());
    -1
}

fn result_bytes() -> (usize, usize) {
    let guard = RESULT.lock().unwrap();
    guard
        .as_ref()
        .map(|v| (v.as_ptr() as usize, v.len()))
        .unwrap_or((0, 0))
}

/// Allocate an input buffer in wasm linear memory (JS writes into it).
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> usize {
    ffi::alloc_bytes(len)
}

/// Free an input buffer previously returned by `alloc`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn dealloc(ptr: usize, len: usize) {
    ffi::free_bytes(ptr, len)
}

/// Initialize the database connection. If `len > 0`, `[ptr, ptr+len)` holds a
/// previously exported DB image (from `export_db`) and is deserialized in.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn init(ptr: usize, len: usize) -> i32 {
    let conn = match Connection::open_in_memory() {
        Ok(c) => c,
        Err(e) => return set_error(e),
    };
    // Serialize-based persistence captures only the main database file, so a
    // write-ahead journal must not be left behind. DELETE mode keeps every
    // committed byte inside the serialized image.
    let _ = conn.pragma_update(None, "journal_mode", "DELETE");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");

    if len == 0 {
        *DB.lock().unwrap() = Some(conn);
        return 0;
    }
    let bytes = ffi::read_bytes(ptr, len);
    let mut guard = DB.lock().unwrap();
    match ffi::deserialize_into(conn, bytes) {
        Ok(conn) => {
            *guard = Some(conn);
            0
        }
        Err(e) => set_error(e),
    }
}

/// Execute a statement without a result set (INSERT/UPDATE/DDL).
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn run(sql_ptr: usize, sql_len: usize, params_ptr: usize, params_len: usize) -> i32 {
    let sql_bytes = ffi::read_bytes(sql_ptr, sql_len);
    let sql = String::from_utf8_lossy(&sql_bytes);
    let params_json = ffi::read_bytes(params_ptr, params_len);
    let guard = DB.lock().unwrap();
    let Some(conn) = guard.as_ref() else {
        return set_error("database not initialized (call init first)");
    };
    match run_stmt(conn, &sql, &params_json) {
        Ok(()) => 0,
        Err(e) => set_error(e),
    }
}

/// Run a query and leave the JSON row array in the result buffer.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn query(sql_ptr: usize, sql_len: usize, params_ptr: usize, params_len: usize) -> i32 {
    let sql_bytes = ffi::read_bytes(sql_ptr, sql_len);
    let sql = String::from_utf8_lossy(&sql_bytes);
    let params_json = ffi::read_bytes(params_ptr, params_len);
    let guard = DB.lock().unwrap();
    let Some(conn) = guard.as_ref() else {
        return set_error("database not initialized (call init first)");
    };
    match query_stmt(conn, &sql, &params_json) {
        Ok(rows) => {
            set_result(rows.into_bytes());
            0
        }
        Err(e) => set_error(e),
    }
}

/// Serialize the whole main database into the result buffer.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn export_db() -> i32 {
    let guard = DB.lock().unwrap();
    let Some(conn) = guard.as_ref() else {
        return set_error("database not initialized (call init first)");
    };
    match ffi::serialize_from(conn) {
        Ok(bytes) => {
            set_result(bytes);
            0
        }
        Err(e) => set_error(e),
    }
}

/// Offset of the result buffer (query rows, exported DB image, or error text).
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn result_ptr() -> usize {
    result_bytes().0
}

/// Length of the result buffer.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    result_bytes().1
}

fn parse_params(json: &[u8]) -> Result<Vec<Value>, String> {
    if json.is_empty() {
        return Ok(Vec::new());
    }
    let arr: Vec<serde_json::Value> = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    arr.into_iter()
        .map(|v| match v {
            serde_json::Value::Null => Ok(Value::Null),
            serde_json::Value::Bool(b) => Ok(Value::Integer(b as i64)),
            serde_json::Value::Number(n) => n
                .as_i64()
                .map(Value::Integer)
                .or_else(|| n.as_f64().map(Value::Real))
                .ok_or_else(|| "unsupported number".to_string()),
            serde_json::Value::String(s) => Ok(Value::Text(s)),
            _ => Err("unsupported param type".to_string()),
        })
        .collect()
}

fn run_stmt(conn: &Connection, sql: &str, params_json: &[u8]) -> Result<(), String> {
    let params = parse_params(params_json)?;
    conn.execute(sql, params_from_iter(params.iter()))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn query_stmt(conn: &Connection, sql: &str, params_json: &[u8]) -> Result<String, String> {
    let params = parse_params(params_json)?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let column_count = stmt.column_count();
    let column_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|n| n.to_string())
        .collect();
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            let mut obj = serde_json::Map::new();
            for i in 0..column_count {
                let name = column_names[i].clone();
                let value = match row.get_ref(i) {
                    Ok(v) => match v {
                        ValueRef::Null => serde_json::Value::Null,
                        ValueRef::Integer(i) => serde_json::Value::from(i),
                        ValueRef::Real(f) => serde_json::Number::from_f64(f)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null),
                        ValueRef::Text(t) => {
                            serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                        }
                        ValueRef::Blob(b) => serde_json::Value::String(format!("blob:{}", b.len())),
                    },
                    Err(_) => serde_json::Value::Null,
                };
                obj.insert(name, value);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[cfg(test)]
#[allow(unsafe_code)]
mod tests {
    use super::*;

    fn write_str(s: &str) -> (usize, usize) {
        let len = s.len();
        let ptr = alloc(len);
        unsafe {
            std::ptr::copy_nonoverlapping(s.as_ptr(), ptr as *mut u8, s.len());
        }
        (ptr, len)
    }

    fn drain_result() -> Vec<u8> {
        let (ptr, len) = result_bytes();
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }.to_vec()
    }

    #[test]
    fn run_query_export_round_trip() {
        assert_eq!(init(0, 0), 0);

        let (sql, slen) = write_str("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
        assert_eq!(run(sql, slen, 0, 0), 0);
        dealloc(sql, slen);

        let (sql, slen) = write_str("INSERT INTO items (name) VALUES (?1), (?2)");
        let (p, plen) = write_str("[\"alpha\",\"beta\"]");
        assert_eq!(run(sql, slen, p, plen), 0);
        dealloc(sql, slen);
        dealloc(p, plen);

        let (sql, slen) = write_str("SELECT id, name FROM items ORDER BY id");
        assert_eq!(query(sql, slen, 0, 0), 0);
        let rows = drain_result();
        let json = String::from_utf8_lossy(&rows);
        assert!(json.contains("alpha"));
        assert!(json.contains("beta"));
        dealloc(sql, slen);

        assert_eq!(export_db(), 0);
        let image = drain_result();
        assert!(!image.is_empty());
        assert!(image.starts_with(b"SQLite format 3\0"));

        // Reload: init from the exported image must preserve data.
        let (ptr, len) = (image.as_ptr() as usize, image.len() as usize);
        assert_eq!(init(ptr, len), 0);
        let (sql, slen) = write_str("SELECT COUNT(*) AS c FROM items");
        assert_eq!(query(sql, slen, 0, 0), 0);
        let buf = drain_result();
        let json = String::from_utf8_lossy(&buf);
        assert!(json.contains("\"c\":2"), "unexpected count json: {json}");
    }

    #[test]
    fn init_empty_creates_usable_db() {
        assert_eq!(init(0, 0), 0);
        let (sql, slen) = write_str("CREATE TABLE t (x)");
        assert_eq!(run(sql, slen, 0, 0), 0);
        let (sql, slen) = write_str("SELECT x FROM t");
        assert_eq!(query(sql, slen, 0, 0), 0);
    }
}
