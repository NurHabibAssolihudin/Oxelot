//! Oxelot SQLite OPFS VFS.
//!
//! NOTE: The JS glue for the OPFS VFS is provided at runtime by the
//! WASM loader (see `packages/core/src/wasm.ts`). This crate exposes a thin
//! SQLite wrapper so the worker can `run`/`query` SQL statements.
//!
//! Building (requires Rust toolchain):
//!   rustup target add wasm32-unknown-unknown
//!   cargo build --release --target wasm32-unknown-unknown
//!   wasm-pack build --target web --out-dir ../packages/core/dist/wasm --release
#![deny(unsafe_code)]

use rusqlite::Connection;
use wasm_bindgen::prelude::*;

use std::sync::Mutex;

static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// Initialize (or re-open) the database. In a real OPFS build the connection
/// uses the OPFS VFS registered by the JS glue; this stub opens in-memory.
#[wasm_bindgen]
pub fn init(db_name: &str) -> Result<(), JsError> {
    let mut slot = DB.lock().unwrap();
    if slot.is_none() {
        let conn = Connection::open_in_memory().map_err(JsError::from)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        *slot = Some(conn);
    }
    let _ = db_name;
    Ok(())
}

/// Execute a statement without a result set (INSERT/UPDATE/DDL).
#[wasm_bindgen]
pub fn run(sql: &str, params_json: &str) -> Result<(), JsError> {
    let slot = DB.lock().unwrap();
    let conn = slot.as_ref().ok_or_else(|| JsError::new("db not initialized"))?;
    let params = parse_params(params_json)?;
    conn.execute(sql, params).map_err(JsError::from)?;
    Ok(())
}

/// Run a query and return rows as a JSON array of objects.
#[wasm_bindgen]
pub fn query(sql: &str, params_json: &str) -> Result<String, JsError> {
    let slot = DB.lock().unwrap();
    let conn = slot.as_ref().ok_or_else(|| JsError::new("db not initialized"))?;
    let params = parse_params(params_json)?;
    let mut stmt = conn.prepare(sql).map_err(JsError::from)?;
    let column_count = stmt.column_count();
    let rows = stmt
        .query(params)
        .map_err(JsError::from)?
        .mapped(|row| {
            let mut obj = serde_json::Map::new();
            for i in 0..column_count {
                let name = row.as_ref().column_name(i).unwrap_or_default().to_string();
                let value = match row.get_ref(i).map_err(rusqlite::Error::InvalidColumnIndex) {
                    Ok(v) => match v {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(i) => serde_json::Value::from(i),
                        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null),
                        rusqlite::types::ValueRef::Text(t) => {
                            serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                        }
                        rusqlite::types::ValueRef::Blob(b) => {
                            serde_json::Value::String(format!("blob:{}", b.len()))
                        }
                    },
                    Err(_) => serde_json::Value::Null,
                };
                obj.insert(name, value);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(JsError::from)?;
    serde_json::to_string(&rows).map_err(JsError::from)
}

fn parse_params(params_json: &str) -> Result<Vec<rusqlite::types::Value>, JsError> {
    if params_json.is_empty() {
        return Ok(Vec::new());
    }
    let arr: Vec<serde_json::Value> = serde_json::from_str(params_json).map_err(JsError::from)?;
    arr.into_iter()
        .map(|v| match v {
            serde_json::Value::Null => Ok(rusqlite::types::Value::Null),
            serde_json::Value::Bool(b) => Ok(rusqlite::types::Value::Integer(b as i64)),
            serde_json::Value::Number(n) => n
                .as_i64()
                .map(rusqlite::types::Value::Integer)
                .or_else(|| n.as_f64().map(rusqlite::types::Value::Real))
                .ok_or_else(|| JsError::new("unsupported number")),
            serde_json::Value::String(s) => Ok(rusqlite::types::Value::Text(s)),
            _ => Err(JsError::new("unsupported param type")),
        })
        .collect()
}
