use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use titor::{Titor, TitorBuilder, CompressionStrategy, CheckpointDiff, GcStats};
use titor::types::{DiffOptions, DetailedCheckpointDiff};
use anyhow::anyhow;
use log::{info, debug};

/// Information about a checkpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    /// The checkpoint ID (from titor)
    #[serde(rename = "checkpointId")]
    pub id: String,
    /// Message index this checkpoint corresponds to
    pub message_index: usize,
    /// Timestamp when checkpoint was created
    #[serde(rename = "timestamp")]
    pub created_at: String,
    /// Session ID this checkpoint belongs to
    pub session_id: Option<String>,
    /// Description or summary of the checkpoint
    pub description: Option<String>,
    /// Number of files in the checkpoint
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// Total size of files
    #[serde(rename = "totalSize")]
    pub total_size: u64,
}

/// Timeline information for UI visualization
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineInfo {
    /// Current checkpoint ID
    pub current_checkpoint_id: Option<String>,
    /// Map of message indices to checkpoint IDs
    pub checkpoints: Vec<CheckpointInfo>,
    /// Timeline tree structure (if available from titor)
    pub timeline_tree: Option<serde_json::Value>,
}

/// Result of a restore operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// Number of files restored
    pub files_restored: usize,
    /// Number of files deleted
    pub files_deleted: usize,
    /// Total bytes written
    pub bytes_written: u64,
    /// Duration in milliseconds
    pub duration_ms: u64,
    /// Any warnings during restoration
    pub warnings: Vec<String>,
    /// Message index this checkpoint corresponds to (for UI truncation)
    pub message_index: usize,
}

/// Manages Titor checkpoints for a Claude Code session
pub struct TitorCheckpointManager {
    /// The Titor instance
    titor: Arc<Mutex<Titor>>,
    /// Map of message index to checkpoint ID
    checkpoint_map: Arc<RwLock<HashMap<usize, String>>>,
    /// Checkpoint metadata cache
    checkpoint_cache: Arc<RwLock<Vec<CheckpointInfo>>>,
    /// Session ID for this manager
    session_id: String,
}

impl TitorCheckpointManager {
    /// Initialize Titor for a project if not already initialized
    pub async fn new(project_path: PathBuf, session_id: String) -> Result<Self> {
        info!("Creating TitorCheckpointManager for session {} at path {:?}", session_id, project_path);
        
        let storage_path = project_path.join(".titor");
        
        // Initialize or open existing Titor repository
        let titor = if storage_path.exists() {
            info!("Opening existing Titor repository");
            Titor::open(project_path.clone(), storage_path)?
        } else {
            info!("Creating new Titor repository");
            TitorBuilder::new()
                .compression_strategy(CompressionStrategy::Adaptive {
                    min_size: 4096,
                    skip_extensions: vec![
                        "jpg", "jpeg", "png", "gif", "mp4", "mp3", 
                        "zip", "gz", "bz2", "7z", "rar"
                    ].iter().map(|s| s.to_string()).collect(),
                })
                .ignore_patterns(vec![
                    ".git".to_string(),
                    ".titor".to_string(),
                    "node_modules".to_string(),
                    "target".to_string(),
                    "dist".to_string(),
                    "build".to_string(),
                    ".next".to_string(),
                    "__pycache__".to_string(),
                    "*.log".to_string(),
                ])
                .build(project_path.clone(), storage_path)?
        };
        
        let manager = Self {
            titor: Arc::new(Mutex::new(titor)),
            checkpoint_map: Arc::new(RwLock::new(HashMap::new())),
            checkpoint_cache: Arc::new(RwLock::new(Vec::new())),
            session_id,
        };
        
        // Load ALL existing checkpoints for this project (not filtered by session)
        manager.refresh_checkpoints().await?;
        
        Ok(manager)
    }
    
    /// Refresh checkpoint list from Titor (loads ALL checkpoints)
    async fn refresh_checkpoints(&self) -> Result<()> {
        let titor = self.titor.lock().await;
        let checkpoints = titor.list_checkpoints()?;
        
        let mut checkpoint_infos = Vec::new();
        let mut checkpoint_map = HashMap::new();
        
        for cp in checkpoints {
            // Parse session ID and message index from description
            let mut parsed_session_id: Option<String> = None;
            let mut parsed_message_index: Option<usize> = None;
            if let Some(desc) = &cp.description {
                // Example desc: "[session_id] idx:3 truncated message..."
                if let Some(end_bracket_pos) = desc.find(']') {
                    // Extract session ID between brackets
                    parsed_session_id = Some(desc[1..end_bracket_pos].to_string());
                    // After the bracket, look for "idx:" marker
                    if let Some(idx_pos) = desc[end_bracket_pos+1..].find("idx:") {
                        // Calculate the absolute start of the index digits
                        let idx_start = end_bracket_pos + 1 + idx_pos + "idx:".len();
                        let idx_substr = &desc[idx_start..];
                        // Collect consecutive digits for the index
                        let idx_digits: String = idx_substr.chars().take_while(|c| c.is_digit(10)).collect();
                        if let Ok(idx) = idx_digits.parse::<usize>() {
                            parsed_message_index = Some(idx);
                        }
                    }
                }
            }
            let (parsed_session_id, message_index) = (parsed_session_id, parsed_message_index);
            
            // Clean up description: strip prefix and any JSON payload
            let description = if let Some(desc) = &cp.description {
                // Build prefix marker: '] idx:<message_index>'
                let idx_val = message_index.unwrap_or(0);
                let prefix = format!("] idx:{}", idx_val);
                if let Some(pos) = desc.find(&prefix) {
                    // Start after prefix
                    let mut remainder = &desc[pos + prefix.len()..];
                    // Trim leading whitespace
                    remainder = remainder.trim_start();
                    // If there's a JSON object, strip it
                    if let Some(json_pos) = remainder.find('{') {
                        remainder = &remainder[..json_pos];
                    }
                    // Truncate to 100 chars
                    let text = remainder.trim();
                    if text.len() > 100 { format!("{}...", &text[..100]) } else { text.to_string() }
                } else {
                    desc.clone()
                }
            } else {
                String::new()
            };
            let info = CheckpointInfo {
                id: cp.id.clone(),
                created_at: cp.timestamp.to_rfc3339(),
                message_index: message_index.unwrap_or(0),
                session_id: parsed_session_id.clone(),
                // Use sanitized description
                description: Some(description),
                file_count: cp.metadata.file_count,
                total_size: cp.metadata.total_size,
            };
            
            checkpoint_infos.push(info);
            
            // Add to map for current session lookups
            if let (Some(sid), Some(idx)) = (parsed_session_id, message_index) {
                if sid == self.session_id {
                    checkpoint_map.insert(idx, cp.id);
                }
            }
        }
        
        // Sort by timestamp (newest first) for consistent ordering
        checkpoint_infos.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        
        info!("Loaded {} total checkpoints for project", checkpoint_infos.len());
        
        *self.checkpoint_cache.write().await = checkpoint_infos;
        *self.checkpoint_map.write().await = checkpoint_map;
        
        Ok(())
    }
    
    /// Create checkpoint after each Claude message/response
    pub async fn checkpoint_message(&self, message_index: usize, message: &str) -> Result<String> {
        let mut titor = self.titor.lock().await;
        
        // Build description with session ID prefix and message index
        let truncated_msg = if message.len() > 100 {
            format!("{}...", &message[..100])
        } else {
            message.to_string()
        };
        
        // Include session ID and message index in description for filtering
        let description = format!("[{}] idx:{} {}", self.session_id, message_index, truncated_msg);
        
        debug!("Creating checkpoint with description: {}", description);
        
        let checkpoint = titor.checkpoint(Some(description.clone()))
            .map_err(|e| anyhow!("Failed to create checkpoint: {}", e))?;
        let id = checkpoint.id.clone();
        
        info!("Created checkpoint {} for session {} at message index {}", id, self.session_id, message_index);
        
        // Update checkpoint map
        {
            let mut map = self.checkpoint_map.write().await;
            map.insert(message_index, id.clone());
        }
        
        // Update cache
        {
            let mut cache = self.checkpoint_cache.write().await;
            cache.push(CheckpointInfo {
                id: id.clone(),
                message_index,
                created_at: checkpoint.timestamp.to_rfc3339(),
                session_id: Some(self.session_id.clone()),
                description: Some(truncated_msg), // Store the truncated message without prefix
                file_count: checkpoint.metadata.file_count,
                total_size: checkpoint.metadata.total_size,
            });
        }
        
        Ok(id)
    }
    
    /// Get checkpoint for a specific message index
    pub async fn get_checkpoint_at_message(&self, message_index: usize) -> Option<String> {
        let map = self.checkpoint_map.read().await;
        map.get(&message_index).cloned()
    }
    
    /// Restore to checkpoint and update session JSONL
    pub async fn restore_to_checkpoint(&self, checkpoint_id: &str) -> Result<RestoreResult> {
        let mut titor = self.titor.lock().await;
        
        let start = std::time::Instant::now();
        let result = titor.restore(checkpoint_id)?;
        let duration = start.elapsed();

        // Determine the message index for this checkpoint so the UI can trim history
        let msg_index = {
            let map = self.checkpoint_map.read().await;
            map.iter()
                .find_map(|(idx, id)| if id == checkpoint_id { Some(*idx) } else { None })
                .unwrap_or_default()
        };
        
        // IMPORTANT: We do NOT clear checkpoints after the restore point
        // All checkpoints remain valid and accessible for time travel
        // The UI should allow navigating to any checkpoint, regardless of current position
        
        Ok(RestoreResult {
            files_restored: result.files_restored,
            files_deleted: result.files_deleted,
            bytes_written: result.bytes_written,
            duration_ms: duration.as_millis() as u64,
            warnings: result.warnings,
            message_index: msg_index,
        })
    }
    
    /// Get timeline information for UI
    pub async fn get_timeline_info(&self) -> Result<TimelineInfo> {
        let titor = self.titor.lock().await;
        let timeline = titor.get_timeline()?;
        
        // Get current checkpoint
        let current_checkpoint_id = timeline.current_checkpoint_id.clone();
        
        // Get cached checkpoint info
        let checkpoints = {
            let cache = self.checkpoint_cache.read().await;
            cache.clone()
        };
        
        // Convert timeline tree to JSON for visualization
        let timeline_tree = serde_json::to_value(&timeline)?;
        
        Ok(TimelineInfo {
            current_checkpoint_id,
            checkpoints,
            timeline_tree: Some(timeline_tree),
        })
    }
    
    /// List all checkpoints
    pub async fn list_checkpoints(&self) -> Result<Vec<CheckpointInfo>> {
        let cache = self.checkpoint_cache.read().await;
        Ok(cache.clone())
    }
    
    /// Fork from a checkpoint
    pub async fn fork_from_checkpoint(&self, checkpoint_id: &str, description: Option<String>) -> Result<String> {
        let mut titor = self.titor.lock().await;
        
        // Include session ID in fork description
        let fork_description = description.map(|desc| {
            format!("[{}] {}", self.session_id, desc)
        });
        
        let fork = titor.fork(checkpoint_id, fork_description)?;
        Ok(fork.id)
    }
    
    /// Get diff between two checkpoints using titor's native diff
    pub async fn diff_checkpoints(&self, from_id: &str, to_id: &str) -> Result<CheckpointDiff> {
        let titor = self.titor.lock().await;
        Ok(titor.diff(from_id, to_id)?)
    }
    
    /// Get detailed diff with line-level changes between two checkpoints
    pub async fn diff_checkpoints_detailed(&self, from_id: &str, to_id: &str, options: DiffOptions) -> Result<DetailedCheckpointDiff> {
        let titor = self.titor.lock().await;
        Ok(titor.diff_detailed(from_id, to_id, options)?)
    }
    
    /// Verify checkpoint integrity
    pub async fn verify_checkpoint(&self, checkpoint_id: &str) -> Result<bool> {
        let titor = self.titor.lock().await;
        let report = titor.verify_checkpoint(checkpoint_id)?;
        Ok(report.is_valid())
    }
    
    /// Garbage collect unreferenced objects using titor's native gc
    pub async fn gc(&self) -> Result<GcStats> {
        let titor = self.titor.lock().await;
        Ok(titor.gc()?)
    }
}