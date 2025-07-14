use tauri::{command, State};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use anyhow::Result;
use titor::{CheckpointDiff, GcStats};
use titor::types::{DiffOptions, DetailedCheckpointDiff, LineChange};

use super::manager::{TitorCheckpointManager, CheckpointInfo, TimelineInfo, RestoreResult};

/// Global state for managing checkpoints across sessions
pub struct CheckpointState {
    /// Map of session ID to checkpoint manager
    managers: Arc<Mutex<HashMap<String, Arc<TitorCheckpointManager>>>>,
}

impl CheckpointState {
    pub fn new() -> Self {
        Self {
            managers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    pub async fn get_or_create_manager(&self, project_path: PathBuf, session_id: String) -> Result<Arc<TitorCheckpointManager>> {
        let mut managers = self.managers.lock().await;
        
        if let Some(manager) = managers.get(&session_id) {
            Ok(manager.clone())
        } else {
            let manager = Arc::new(TitorCheckpointManager::new(project_path.clone(), session_id.clone()).await?);
            managers.insert(session_id.clone(), manager.clone());
            
            Ok(manager)
        }
    }
}

/// Response type that serializes titor's native types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitorDiffResponse {
    /// Source checkpoint ID
    pub from_id: String,
    /// Target checkpoint ID  
    pub to_id: String,
    /// Files added in target
    pub added_files: Vec<serde_json::Value>,
    /// Files modified between checkpoints
    pub modified_files: Vec<serde_json::Value>,
    /// Files deleted in target
    pub deleted_files: Vec<serde_json::Value>,
    /// Change statistics
    pub stats: serde_json::Value,
}

impl From<CheckpointDiff> for TitorDiffResponse {
    fn from(diff: CheckpointDiff) -> Self {
        Self {
            from_id: diff.from_id,
            to_id: diff.to_id,
            added_files: diff.added_files.into_iter()
                .map(|f| serde_json::to_value(f).unwrap_or_default())
                .collect(),
            modified_files: diff.modified_files.into_iter()
                .map(|(old, new)| serde_json::json!({
                    "old": serde_json::to_value(old).unwrap_or_default(),
                    "new": serde_json::to_value(new).unwrap_or_default()
                }))
                .collect(),
            deleted_files: diff.deleted_files.into_iter()
                .map(|f| serde_json::to_value(f).unwrap_or_default())
                .collect(),
            stats: serde_json::to_value(diff.stats).unwrap_or_default(),
        }
    }
}

/// Response type for GC stats
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitorGcResponse {
    /// Serialized GC stats
    pub stats: serde_json::Value,
}

impl From<GcStats> for TitorGcResponse {
    fn from(stats: GcStats) -> Self {
        Self {
            stats: serde_json::to_value(stats).unwrap_or_default(),
        }
    }
}

/// Response for a single line change in a diff
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineChangeResponse {
    /// Type of change: "added", "deleted", or "context"
    pub change_type: String,
    /// Line number in the file
    pub line_number: usize,
    /// Content of the line
    pub content: String,
}

/// Response for a hunk of changes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkResponse {
    /// Starting line in the from file
    pub from_line: usize,
    /// Number of lines in the from file
    pub from_count: usize,
    /// Starting line in the to file
    pub to_line: usize,
    /// Number of lines in the to file
    pub to_count: usize,
    /// Line changes in this hunk
    pub changes: Vec<LineChangeResponse>,
}

/// Response for a file diff with line-level changes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResponse {
    /// Path of the file
    pub path: String,
    /// Whether the file is binary
    pub is_binary: bool,
    /// Hunks of changes
    pub hunks: Vec<HunkResponse>,
}

/// Response for detailed diff with line-level changes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedDiffResponse {
    /// Basic diff information (files added/modified/deleted)
    pub basic_diff: TitorDiffResponse,
    /// Detailed file diffs with line-level changes
    pub file_diffs: Vec<FileDiffResponse>,
    /// Total lines added across all files
    pub total_lines_added: usize,
    /// Total lines deleted across all files
    pub total_lines_deleted: usize,
}

impl DetailedDiffResponse {
    fn from_detailed_diff(diff: DetailedCheckpointDiff) -> Self {
        let basic_diff = TitorDiffResponse::from(diff.basic_diff.clone());
        
        let file_diffs = diff.file_diffs.into_iter().map(|fd| {
            FileDiffResponse {
                path: fd.path.display().to_string(),
                is_binary: fd.is_binary,
                hunks: fd.hunks.into_iter().map(|hunk| {
                    HunkResponse {
                        from_line: hunk.from_line,
                        from_count: hunk.from_count,
                        to_line: hunk.to_line,
                        to_count: hunk.to_count,
                        changes: hunk.changes.into_iter().map(|change| {
                            match change {
                                LineChange::Added(line_num, content) => LineChangeResponse {
                                    change_type: "added".to_string(),
                                    line_number: line_num,
                                    content,
                                },
                                LineChange::Deleted(line_num, content) => LineChangeResponse {
                                    change_type: "deleted".to_string(),
                                    line_number: line_num,
                                    content,
                                },
                                LineChange::Context(line_num, content) => LineChangeResponse {
                                    change_type: "context".to_string(),
                                    line_number: line_num,
                                    content,
                                },
                            }
                        }).collect(),
                    }
                }).collect(),
            }
        }).collect();
        
        Self {
            basic_diff,
            file_diffs,
            total_lines_added: diff.total_lines_added,
            total_lines_deleted: diff.total_lines_deleted,
        }
    }
}

// Tauri Commands

#[command]
pub async fn titor_init_session(
    state: State<'_, CheckpointState>,
    project_path: String,
    session_id: String,
) -> Result<(), String> {
    state.get_or_create_manager(PathBuf::from(project_path), session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn titor_checkpoint_message(
    state: State<'_, CheckpointState>,
    session_id: String,
    message_index: usize,
    message: String,
) -> Result<String, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    let checkpoint_id = manager.checkpoint_message(message_index, &message)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(checkpoint_id)
}

#[command]
pub async fn titor_get_checkpoint_at_message(
    state: State<'_, CheckpointState>,
    session_id: String,
    message_index: usize,
) -> Result<Option<String>, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    Ok(manager.get_checkpoint_at_message(message_index).await)
}

#[command]
pub async fn titor_restore_checkpoint(
    state: State<'_, CheckpointState>,
    session_id: String,
    checkpoint_id: String,
) -> Result<RestoreResult, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    let result = manager.restore_to_checkpoint(&checkpoint_id)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(result)
}

#[command]
pub async fn titor_get_timeline(
    state: State<'_, CheckpointState>,
    session_id: String,
) -> Result<TimelineInfo, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    manager.get_timeline_info()
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn titor_list_checkpoints(
    state: State<'_, CheckpointState>,
    session_id: String,
) -> Result<Vec<CheckpointInfo>, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    // Get all checkpoints for the project
    let all_checkpoints = manager.list_checkpoints()
        .await
        .map_err(|e| e.to_string())?;
    // Filter only those created by this session
    let session_checkpoints: Vec<CheckpointInfo> = all_checkpoints
        .into_iter()
        .filter(|cp| cp.session_id.as_deref() == Some(session_id.as_str()))
        .collect();
    Ok(session_checkpoints)
}

#[command]
pub async fn titor_fork_checkpoint(
    state: State<'_, CheckpointState>,
    session_id: String,
    checkpoint_id: String,
    description: Option<String>,
) -> Result<String, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    manager.fork_from_checkpoint(&checkpoint_id, description)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn titor_diff_checkpoints(
    state: State<'_, CheckpointState>,
    session_id: String,
    from_id: String,
    to_id: String,
) -> Result<TitorDiffResponse, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    let diff = manager.diff_checkpoints(&from_id, &to_id)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(diff.into())
}

#[command]
pub async fn titor_verify_checkpoint(
    state: State<'_, CheckpointState>,
    session_id: String,
    checkpoint_id: String,
) -> Result<bool, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    manager.verify_checkpoint(&checkpoint_id)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn titor_gc(
    state: State<'_, CheckpointState>,
    session_id: String,
) -> Result<TitorGcResponse, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    let stats = manager.gc()
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(stats.into())
}

#[command]
pub async fn titor_diff_checkpoints_detailed(
    state: State<'_, CheckpointState>,
    session_id: String,
    from_id: String,
    to_id: String,
    context_lines: Option<usize>,
    ignore_whitespace: Option<bool>,
) -> Result<DetailedDiffResponse, String> {
    let managers = state.managers.lock().await;
    let manager = managers.get(&session_id)
        .ok_or("Session not initialized")?;
    
    let options = DiffOptions {
        context_lines: context_lines.unwrap_or(3),
        ignore_whitespace: ignore_whitespace.unwrap_or(false),
        show_line_numbers: true,
        max_file_size: 10 * 1024 * 1024, // 10MB
    };
    
    let diff = manager.diff_checkpoints_detailed(&from_id, &to_id, options)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(DetailedDiffResponse::from_detailed_diff(diff))
}



/// List all checkpoints for a project (across all sessions)
#[command]
pub async fn titor_list_all_checkpoints(
    _state: State<'_, CheckpointState>,
    project_path: String,
) -> Result<Vec<CheckpointInfo>, String> {
    let project_path = PathBuf::from(project_path);
    
    // Create a temporary manager to list all checkpoints
    let temp_manager = TitorCheckpointManager::new(project_path, "temp".to_string())
        .await
        .map_err(|e| format!("Failed to create manager: {}", e))?;
    
    temp_manager.list_checkpoints()
        .await
        .map_err(|e| format!("Failed to list checkpoints: {}", e))
} 