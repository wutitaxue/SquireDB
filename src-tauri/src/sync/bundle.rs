use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::snapshot::Snapshot;
use super::{DB_SCHEMA_VERSION, PROTOCOL_VERSION};

const META_ENTRY: &str = "meta.json";
const SNAPSHOT_ENTRY: &str = "snapshot.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleMeta {
    pub protocol_version: u32,
    pub db_schema_version: u32,
    pub device_name: String,
    pub exported_at: String,
    pub app_version: String,
    pub summary: BundleSummary,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BundleSummary {
    pub connections: usize,
    pub projects: usize,
    pub project_tables: usize,
    pub project_relations: usize,
    pub schema_relations: usize,
    pub saved_queries: usize,
    pub ai_models: usize,
    pub embedding_models: usize,
    pub mcp_settings: usize,
    pub settings: usize,
}

impl BundleMeta {
    fn from_snapshot(snapshot: &Snapshot) -> Self {
        Self {
            protocol_version: snapshot.protocol_version,
            db_schema_version: snapshot.db_schema_version,
            device_name: snapshot.device_name.clone(),
            exported_at: snapshot.exported_at.clone(),
            app_version: snapshot.app_version.clone(),
            summary: BundleSummary {
                connections: snapshot.connections.len(),
                projects: snapshot.projects.len(),
                project_tables: snapshot.project_tables.len(),
                project_relations: snapshot.project_relations.len(),
                schema_relations: snapshot.schema_relations.len(),
                saved_queries: snapshot.saved_queries.len(),
                ai_models: snapshot.ai_models.len(),
                embedding_models: snapshot.embedding_models.len(),
                mcp_settings: snapshot.mcp_settings.as_ref().map(|_| 1).unwrap_or(0),
                settings: snapshot.settings.len(),
            },
        }
    }
}

pub fn pack(snapshot: &Snapshot) -> Result<Vec<u8>, String> {
    let meta = BundleMeta::from_snapshot(snapshot);
    let meta_json = serde_json::to_vec_pretty(&meta).map_err(|e| format!("encode meta: {e}"))?;
    let snapshot_json =
        serde_json::to_vec(snapshot).map_err(|e| format!("encode snapshot: {e}"))?;

    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut zw = ZipWriter::new(cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zw.start_file(META_ENTRY, opts)
            .map_err(|e| format!("zip meta: {e}"))?;
        zw.write_all(&meta_json)
            .map_err(|e| format!("write meta: {e}"))?;

        zw.start_file(SNAPSHOT_ENTRY, opts)
            .map_err(|e| format!("zip snapshot: {e}"))?;
        zw.write_all(&snapshot_json)
            .map_err(|e| format!("write snapshot: {e}"))?;

        zw.finish().map_err(|e| format!("zip finish: {e}"))?;
    }
    Ok(buf)
}

pub fn unpack(bytes: &[u8]) -> Result<(BundleMeta, Snapshot), String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;

    let meta: BundleMeta = {
        let mut f = archive
            .by_name(META_ENTRY)
            .map_err(|e| format!("zip {META_ENTRY}: {e}"))?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("read meta: {e}"))?;
        serde_json::from_str(&s).map_err(|e| format!("parse meta: {e}"))?
    };

    if meta.protocol_version > PROTOCOL_VERSION {
        return Err(format!(
            "bundle protocol_version {} exceeds supported {}; please upgrade SquireDB",
            meta.protocol_version, PROTOCOL_VERSION
        ));
    }
    if meta.db_schema_version > DB_SCHEMA_VERSION {
        return Err(format!(
            "bundle db_schema_version {} exceeds supported {}; please upgrade SquireDB",
            meta.db_schema_version, DB_SCHEMA_VERSION
        ));
    }

    let snapshot: Snapshot = {
        let mut f = archive
            .by_name(SNAPSHOT_ENTRY)
            .map_err(|e| format!("zip {SNAPSHOT_ENTRY}: {e}"))?;
        let mut s = String::new();
        f.read_to_string(&mut s)
            .map_err(|e| format!("read snapshot: {e}"))?;
        serde_json::from_str(&s).map_err(|e| format!("parse snapshot: {e}"))?
    };

    Ok((meta, snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::snapshot::Snapshot;

    fn empty_snapshot() -> Snapshot {
        Snapshot {
            protocol_version: PROTOCOL_VERSION,
            db_schema_version: DB_SCHEMA_VERSION,
            exported_at: "2026-06-29T00:00:00Z".to_string(),
            device_name: "test-device".to_string(),
            app_version: "0.0.0-test".to_string(),
            connections: vec![],
            projects: vec![],
            project_tables: vec![],
            project_relations: vec![],
            schema_relations: vec![],
            saved_queries: vec![],
            ai_models: vec![],
            embedding_models: vec![],
            mcp_settings: None,
            settings: vec![],
        }
    }

    #[test]
    fn pack_then_unpack_roundtrip() {
        let snap = empty_snapshot();
        let bytes = pack(&snap).expect("pack");
        let (meta, restored) = unpack(&bytes).expect("unpack");
        assert_eq!(meta.device_name, snap.device_name);
        assert_eq!(meta.protocol_version, snap.protocol_version);
        assert_eq!(restored.exported_at, snap.exported_at);
    }
}
