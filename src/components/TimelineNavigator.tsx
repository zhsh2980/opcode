/**
 * Timeline Navigator for checkpoint management with time-travel capabilities
 * Provides visual timeline of checkpoints with restore, fork, and verify actions
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import {
  History,
  Clock,
  RotateCcw,
  GitBranchPlus,
  FileText,
  Save,
  Loader2,
  AlertCircle,
  Check,
  Hash,
  Terminal,
  FilePlus,
  FileEdit,
  FileMinus,
  ChevronRight,
  Package,
  FileCode,
  Image,
  FileJson,
  File,
  FolderOpen,
  GitCompare,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";
import * as api from "../lib/api";
import { listen } from '@tauri-apps/api/event';
import type { TitorCheckpointInfo, DetailedDiffResponse } from "../lib/api";
import type { ClaudeStreamMessage } from "./AgentExecution";
import { DiffViewer } from "./DiffViewer";

/**
 * Extended checkpoint info with UI state
 */
interface CheckpointWithUIState extends TitorCheckpointInfo {
  verified?: boolean;
  parentId?: string;
  messageContent?: string;
  toolsUsed?: string[];
  filesChanged?: {
    added: number;
    modified: number;
    deleted: number;
  };
  detailedFileChanges?: {
    added: Array<{ path: string; size?: number }>;
    modified: Array<{ path: string; oldSize?: number; newSize?: number }>;
    deleted: Array<{ path: string; size?: number }>;
  };
}

interface TimelineNavigatorProps {
  /**
   * Session ID for checkpoint operations
   */
  sessionId: string;
  /**
   * Project path for the session
   */
  projectPath: string;
  /**
   * Current message index
   */
  currentMessageIndex: number;
  /**
   * Messages array to extract content and tool usage
   */
  messages: ClaudeStreamMessage[];
  /**
   * Callback when a checkpoint is restored
   */
  onCheckpointRestore?: (checkpointId: string) => void;
  /**
   * Callback when a checkpoint is forked
   */
  onForkCheckpoint?: (forkedCheckpointId: string, forkMessage: string) => void;
  /**
   * Whether to show all checkpoints for the project (across all sessions)
   */
  showAllSessions?: boolean;
  /**
   * Optional className for styling
   */
  className?: string;
}

/**
 * TimelineNavigator component for checkpoint time-travel navigation
 * 
 * @example
 * <TimelineNavigator 
 *   sessionId="session-123" 
 *   projectPath="/path/to/project"
 *   currentMessageIndex={5}
 *   onCheckpointRestore={(id) => console.log('Restored:', id)}
 * />
 */
export const TimelineNavigator: React.FC<TimelineNavigatorProps> = ({
  sessionId,
  projectPath,
  currentMessageIndex,
  messages,
  onCheckpointRestore,
  onForkCheckpoint,
  showAllSessions = false,
  className,
}) => {
  const [checkpoints, setCheckpoints] = useState<CheckpointWithUIState[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
  const [showForkDialog, setShowForkDialog] = useState(false);
  const [forkMessage, setForkMessage] = useState("");
  const [isCreatingCheckpoint, setIsCreatingCheckpoint] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [expandedCheckpoints, setExpandedCheckpoints] = useState<Set<string>>(new Set());
  const [showDiffDialog, setShowDiffDialog] = useState(false);
  const [diffData, setDiffData] = useState<DetailedDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffFromCheckpoint, setDiffFromCheckpoint] = useState<string | null>(null);
  const [diffToCheckpoint, setDiffToCheckpoint] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Load checkpoints when dialog opens or after restoration
  useEffect(() => {
    if (sessionId && isOpen) {
      loadCheckpoints();
    }
  }, [sessionId, isOpen]);
  
  // Also reload checkpoints when currentMessageIndex changes (after restoration)
  useEffect(() => {
    if (sessionId && isOpen && checkpoints.length > 0) {
      // Debounce to avoid multiple calls during message streaming
      const timer = setTimeout(() => {
        loadCheckpoints();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [currentMessageIndex, sessionId, isOpen]);

  // Real-time checkpoint updates: listen for backend events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (sessionId && isOpen) {
      listen<{ checkpointId: string; messageIndex: number }>(
        `checkpoint-created:${sessionId}`,
        () => {
          loadCheckpoints();
        }
      )
        .then((fn) => { unlisten = fn; })
        .catch((err) => { console.error('Failed to listen for checkpoints:', err); });
    }
    return () => { if (unlisten) unlisten(); };
  }, [sessionId, isOpen]);

  // Helper function to extract message content and tools from a message
  const extractMessageInfo = (messageIndex: number) => {
    if (!messages || messageIndex < 0 || messageIndex >= messages.length) {
      return { content: '', tools: [] };
    }

    const message = messages[messageIndex];
    let content = '';
    const tools: string[] = [];

    if (message.type === 'assistant' && message.message?.content) {
      // Extract text content and tool usage
      if (Array.isArray(message.message.content)) {
        for (const item of message.message.content) {
          if (item.type === 'text') {
            let textValue = '';
            if (item.text) {
              if (typeof item.text === 'string') {
                textValue = item.text;
              } else {
                textValue = String((item.text as any).text || '');
              }
            }
            if (textValue && content.length < 150) {
              const truncated = textValue.substring(0, 150);
              content = truncated + (textValue.length > 150 ? '...' : '');
            }
          } else if (item.type === 'tool_use' && item.name) {
            tools.push(item.name);
          }
        }
      } else if (typeof message.message.content === 'string') {
        const contentStr = String(message.message.content);
        content = contentStr.substring(0, 150) + 
                 (contentStr.length > 150 ? '...' : '');
      }
    } else if (message.type === 'user' && message.message?.content) {
      // Extract user message text
      if (Array.isArray(message.message.content)) {
        const textContent = message.message.content.find((c: any) => c.type === 'text');
        if (textContent?.text) {
          const text = typeof textContent.text === 'string' ? textContent.text : textContent.text.text || '';
          content = text.substring(0, 150) + (text.length > 150 ? '...' : '');
        }
      }
    }

    return { content: content || 'No content', tools };
  };

  const loadCheckpoints = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      let result: api.TitorCheckpointInfo[];
      if (showAllSessions && projectPath) {
        // Load all checkpoints for the project
        result = await api.titorListAllCheckpoints(projectPath);
      } else {
        // Load only checkpoints for the current session
        result = await api.titorListCheckpoints(sessionId);
      }
      
      // Sort checkpoints by messageIndex to ensure proper ordering
      const sortedCheckpoints = (result || []).sort((a, b) => a.messageIndex - b.messageIndex);
      
      // Enhance checkpoints with message content, tool info, and file diffs
      const enhancedCheckpoints: CheckpointWithUIState[] = await Promise.all(
        sortedCheckpoints.map(async (checkpoint, index) => {
          const { content, tools } = extractMessageInfo(checkpoint.messageIndex);
          
          // Initialize file changes
          let filesChanged = undefined;
          let detailedFileChanges = undefined;
          
          // Get diff with parent/previous checkpoint
          try {
            if (index > 0) {
              // Compare with previous checkpoint
              const prevCheckpoint = sortedCheckpoints[index - 1];
              const diff = await api.titorDiffCheckpoints(
                sessionId,
                prevCheckpoint.checkpointId,
                checkpoint.checkpointId
              );
              
              // Extract file paths from the diff response
              const extractFilePath = (fileObj: any): { path: string; size?: number } => {
                if (typeof fileObj === 'string') return { path: fileObj };
                if (fileObj && typeof fileObj === 'object') {
                  return {
                    path: fileObj.path || fileObj.file_path || fileObj.name || 'Unknown file',
                    size: fileObj.size || fileObj.file_size || fileObj.total_size
                  };
                }
                return { path: 'Unknown file' };
              };
              
              detailedFileChanges = {
                added: diff.addedFiles.map(extractFilePath),
                modified: diff.modifiedFiles.map((modPair: any) => {
                  if (modPair && typeof modPair === 'object' && modPair.old && modPair.new) {
                    const oldFile = extractFilePath(modPair.old);
                    const newFile = extractFilePath(modPair.new);
                    return {
                      path: newFile.path,
                      oldSize: oldFile.size,
                      newSize: newFile.size
                    };
                  }
                  return extractFilePath(modPair);
                }),
                deleted: diff.deletedFiles.map(extractFilePath),
              };
              
              filesChanged = {
                added: detailedFileChanges.added.length,
                modified: detailedFileChanges.modified.length,
                deleted: detailedFileChanges.deleted.length,
              };
            } else {
              // First checkpoint - all files are "added"
              filesChanged = {
                added: checkpoint.fileCount,
                modified: 0,
                deleted: 0,
              };
              // For first checkpoint, we don't have detailed file info
              detailedFileChanges = {
                added: [],
                modified: [],
                deleted: []
              };
            }
          } catch (err) {
            console.warn('Failed to get diff for checkpoint:', checkpoint.checkpointId, err);
          }
          
          return {
            ...checkpoint,
            messageContent: content,
            toolsUsed: tools,
            filesChanged,
            detailedFileChanges,
          };
        })
      );
      
      // Filter to only show checkpoints with file changes (UI only)
      const checkpointsWithFileChanges = enhancedCheckpoints.filter(checkpoint => {
        // Check if there are any file changes
        if (checkpoint.filesChanged) {
          const { added, modified, deleted } = checkpoint.filesChanged;
          // Only include if there's at least one file change
          return added > 0 || modified > 0 || deleted > 0;
        }
        
        // If we don't have file change info, exclude it to be safe
        // (since we're filtering for file changes only)
        return false;
      });
      
      setCheckpoints(checkpointsWithFileChanges);
    } catch (err) {
      console.error("Failed to load checkpoints:", err);
      setError("Failed to load checkpoints");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCheckpoint = async () => {
    try {
      setIsCreatingCheckpoint(true);
      setError(null);
      
      const message = `Manual checkpoint at message ${currentMessageIndex + 1}`;
      await api.titorCheckpointMessage(sessionId, currentMessageIndex, message);
      
      // Reload checkpoints
      await loadCheckpoints();
    } catch (err) {
      console.error("Failed to create checkpoint:", err);
      setError("Failed to create checkpoint");
    } finally {
      setIsCreatingCheckpoint(false);
    }
  };

  const handleRestoreCheckpoint = (checkpointId: string) => {
    // Close the timeline dialog and delegate restoration to the parent component
    setIsOpen(false);
    onCheckpointRestore?.(checkpointId);
  };

  const handleForkCheckpoint = async () => {
    if (!selectedCheckpoint || !forkMessage.trim()) return;
    
    try {
      setIsRestoring(true);
      setError(null);
      
      // Fork checkpoint returns a new checkpoint ID
      const forkedCheckpointId = await api.titorForkCheckpoint(sessionId, selectedCheckpoint, forkMessage);
      
      // Reload checkpoints
      await loadCheckpoints();
      
      // Close fork dialog
      setShowForkDialog(false);
      setForkMessage("");
      setSelectedCheckpoint(null);
      
      // Close main dialog
      setIsOpen(false);
      
      // Notify parent with the forked checkpoint ID
      onForkCheckpoint?.(forkedCheckpointId, forkMessage);
    } catch (err) {
      console.error("Failed to fork checkpoint:", err);
      setError("Failed to fork checkpoint");
    } finally {
      setIsRestoring(false);
    }
  };

  const handleVerifyCheckpoint = async (checkpointId: string) => {
    try {
      const isValid = await api.titorVerifyCheckpoint(sessionId, checkpointId);
      if (isValid) {
        // Show success indicator briefly
        const checkpoint = checkpoints.find(cp => cp.checkpointId === checkpointId);
        if (checkpoint) {
          setCheckpoints(prev => prev.map(cp => 
            cp.checkpointId === checkpointId 
              ? { ...cp, verified: true } as CheckpointWithUIState
              : cp
          ));
          
          // Reset after 3 seconds
          setTimeout(() => {
            setCheckpoints(prev => prev.map(cp => 
              cp.checkpointId === checkpointId 
                ? { ...cp, verified: undefined } as CheckpointWithUIState
                : cp
            ));
          }, 3000);
        }
      } else {
        setError("Checkpoint verification failed");
      }
    } catch (err) {
      console.error("Failed to verify checkpoint:", err);
      setError("Failed to verify checkpoint");
    }
  };

  // Scroll to current checkpoint when dialog opens
  useEffect(() => {
    if (isOpen && timelineRef.current) {
      const currentCheckpoint = checkpoints.find(cp => cp.messageIndex <= currentMessageIndex);
      if (currentCheckpoint) {
        const element = timelineRef.current.querySelector(`[data-checkpoint-id="${currentCheckpoint.checkpointId}"]`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [isOpen, checkpoints, currentMessageIndex]);

  // Helper function to format bytes in human-readable form
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  // Get file icon based on extension
  const getFileIcon = (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
      case 'py':
      case 'rs':
      case 'go':
      case 'java':
      case 'cpp':
      case 'c':
      case 'h':
      case 'hpp':
        return <FileCode className="h-4 w-4" />;
      case 'json':
      case 'yaml':
      case 'yml':
      case 'toml':
      case 'xml':
        return <FileJson className="h-4 w-4" />;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
      case 'webp':
        return <Image className="h-4 w-4" />;
      case 'md':
      case 'mdx':
      case 'txt':
      case 'doc':
      case 'docx':
        return <FileText className="h-4 w-4" />;
      default:
        return <File className="h-4 w-4" />;
    }
  };

  // Toggle expanded state
  const toggleExpanded = (checkpointId: string) => {
    setExpandedCheckpoints(prev => {
      const newSet = new Set(prev);
      if (newSet.has(checkpointId)) {
        newSet.delete(checkpointId);
      } else {
        newSet.add(checkpointId);
      }
      return newSet;
    });
  };

  // Show diff between two checkpoints
  const showDiff = async (fromCheckpointId: string, toCheckpointId: string) => {
    try {
      setDiffLoading(true);
      setDiffFromCheckpoint(fromCheckpointId);
      setDiffToCheckpoint(toCheckpointId);
      setShowDiffDialog(true);
      
      const diff = await api.titorDiffCheckpointsDetailed(
        sessionId,
        fromCheckpointId,
        toCheckpointId,
        3, // context lines
        false // don't ignore whitespace
      );
      
      setDiffData(diff);
    } catch (err) {
      console.error("Failed to get detailed diff:", err);
      setError("Failed to load diff");
      setShowDiffDialog(false);
    } finally {
      setDiffLoading(false);
    }
  };

  const timelineContent = (
    <div className="space-y-3">
      {checkpoints.map((checkpoint, index) => {
        const isActive = checkpoint.messageIndex <= currentMessageIndex &&
                        (index === checkpoints.length - 1 || checkpoints[index + 1].messageIndex > currentMessageIndex);
        const isExpanded = expandedCheckpoints.has(checkpoint.checkpointId);
        
        // Calculate total changes
        const totalChanges = (checkpoint.filesChanged?.added || 0) + 
                           (checkpoint.filesChanged?.modified || 0) + 
                           (checkpoint.filesChanged?.deleted || 0);
        
        // Get a summary description
        const changeSummary = [];
        if (checkpoint.filesChanged?.added) changeSummary.push(`${checkpoint.filesChanged.added} added`);
        if (checkpoint.filesChanged?.modified) changeSummary.push(`${checkpoint.filesChanged.modified} modified`);
        if (checkpoint.filesChanged?.deleted) changeSummary.push(`${checkpoint.filesChanged.deleted} deleted`);
        const summaryText = changeSummary.join(', ');
        
        return (
          <motion.div
            key={checkpoint.checkpointId}
            data-checkpoint-id={checkpoint.checkpointId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className={cn(
              "relative group rounded-lg border transition-all",
              isActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
              "hover:shadow-md"
            )}
          >
            {/* Main content */}
            <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Header with file count and time */}
                  <div className="flex items-center gap-3 mb-2">
                    <button
                      onClick={() => toggleExpanded(checkpoint.checkpointId)}
                      className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                    >
                      <div className={cn(
                        "p-1.5 rounded-full transition-colors",
                        isActive ? "bg-primary/20" : "bg-muted"
                      )}>
                        <Package className={cn(
                          "h-4 w-4",
                          isActive ? "text-primary" : "text-muted-foreground"
                        )} />
                      </div>
                      <div className="text-left">
                        <div className="font-medium flex items-center gap-2">
                          {totalChanges === 1 ? '1 file changed' : `${totalChanges} files changed`}
                          <ChevronRight className={cn(
                            "h-3 w-3 transition-transform",
                            isExpanded && "rotate-90"
                          )} />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {summaryText}
                        </div>
                      </div>
                    </button>
                    {checkpoint.verified && (
                      <Badge variant="outline" className="text-xs">
                        <Check className="h-3 w-3 mr-1" />
                        Verified
                      </Badge>
                    )}
                  </div>
                  
                  {/* Tool usage badges */}
                  {checkpoint.toolsUsed && checkpoint.toolsUsed.length > 0 && (
                    <div className="flex items-center gap-1 mb-2">
                      {checkpoint.toolsUsed.map((tool, idx) => (
                        <Badge 
                          key={idx} 
                          variant="secondary" 
                          className="text-xs py-0"
                        >
                          <Terminal className="h-3 w-3 mr-1" />
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  )}
                  
                  {/* Timestamp */}
                  <div className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(checkpoint.timestamp), { addSuffix: true })}
                  </div>
                </div>
                
                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {index > 0 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => showDiff(checkpoints[index - 1].checkpointId, checkpoint.checkpointId)}
                            disabled={diffLoading}
                          >
                            <GitCompare className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>View changes from previous</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => handleRestoreCheckpoint(checkpoint.checkpointId)}
                          disabled={isRestoring || isActive}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Restore to this state</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => {
                            setSelectedCheckpoint(checkpoint.checkpointId);
                            setShowForkDialog(true);
                          }}
                          disabled={isRestoring}
                        >
                          <GitBranchPlus className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Create branch from here</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => handleVerifyCheckpoint(checkpoint.checkpointId)}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Verify integrity</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
              
              {/* Expanded file list */}
              <AnimatePresence>
                {isExpanded && checkpoint.detailedFileChanges && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-3 pt-3 border-t border-border overflow-hidden"
                  >
                    <div className="space-y-2 text-sm">
                      {/* Added files */}
                      {checkpoint.detailedFileChanges.added.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400 mb-1">
                            <FilePlus className="h-3 w-3" />
                            Added ({checkpoint.detailedFileChanges.added.length})
                          </div>
                          {checkpoint.detailedFileChanges.added.map((file, idx) => (
                            <div key={`added-${idx}`} className="flex items-center gap-2 text-green-600 dark:text-green-400 ml-4">
                              {getFileIcon(file.path)}
                              <span className="font-mono text-xs truncate flex-1">{file.path}</span>
                              {file.size && (
                                <span className="text-xs text-muted-foreground">({formatBytes(file.size)})</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {/* Modified files */}
                      {checkpoint.detailedFileChanges.modified.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-xs font-medium text-yellow-600 dark:text-yellow-400 mb-1">
                            <FileEdit className="h-3 w-3" />
                            Modified ({checkpoint.detailedFileChanges.modified.length})
                          </div>
                          {checkpoint.detailedFileChanges.modified.map((file, idx) => (
                            <div key={`modified-${idx}`} className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400 ml-4">
                              {getFileIcon(file.path)}
                              <span className="font-mono text-xs truncate flex-1">{file.path}</span>
                              {file.oldSize && file.newSize && file.oldSize !== file.newSize && (
                                <span className="text-xs text-muted-foreground">
                                  ({formatBytes(file.oldSize)} → {formatBytes(file.newSize)})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {/* Deleted files */}
                      {checkpoint.detailedFileChanges.deleted.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                            <FileMinus className="h-3 w-3" />
                            Deleted ({checkpoint.detailedFileChanges.deleted.length})
                          </div>
                          {checkpoint.detailedFileChanges.deleted.map((file, idx) => (
                            <div key={`deleted-${idx}`} className="flex items-center gap-2 text-red-600 dark:text-red-400 ml-4">
                              {getFileIcon(file.path)}
                              <span className="font-mono text-xs truncate flex-1 line-through">{file.path}</span>
                              {file.size && (
                                <span className="text-xs text-muted-foreground">({formatBytes(file.size)})</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        );
      })}
      
      {/* Current position indicator if needed */}
      {checkpoints.length > 0 && !checkpoints.some(cp => cp.messageIndex === currentMessageIndex) && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative rounded-lg border border-dashed border-primary/50 bg-primary/5 p-4"
        >
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-full bg-primary/20">
              <Hash className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="font-medium text-sm">Current position</div>
              <div className="text-xs text-muted-foreground">
                No file changes since last checkpoint
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );

  return (
    <>
      {/* Timeline Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className={cn("flex items-center gap-2", className)}
      >
        <History className="h-4 w-4" />
        <span>Timeline</span>
        {checkpoints.length > 0 && !isOpen && (
          <Badge variant="secondary" className="text-xs ml-1">
            {checkpoints.length}
          </Badge>
        )}
      </Button>
      
      {/* Timeline Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Project Timeline
              {checkpoints.length > 0 && (
                <Badge variant="secondary" className="text-sm">
                  {checkpoints.length} states
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              View and restore your project to any previous state. Each checkpoint represents a set of file changes.
            </DialogDescription>
          </DialogHeader>
          
          {projectPath && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground border-b pb-3">
              <FolderOpen className="h-4 w-4" />
              <span className="font-mono truncate">{projectPath}</span>
            </div>
          )}
          
          <ScrollArea className="h-[400px] pr-2" ref={timelineRef}>
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            ) : checkpoints.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Clock className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No file changes recorded yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Checkpoints are created automatically when files are modified
                </p>
              </div>
            ) : (
              timelineContent
            )}
          </ScrollArea>
          
          <div className="flex justify-end pt-3 border-t">
            <Button
              size="sm"
              variant="outline"
              onClick={handleCreateCheckpoint}
              disabled={isCreatingCheckpoint || isLoading}
            >
              {isCreatingCheckpoint ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Current State
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Fork Dialog */}
      <Dialog open={showForkDialog} onOpenChange={setShowForkDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Branch</DialogTitle>
            <DialogDescription>
              Create a new branch from this checkpoint. This allows you to explore
              alternative implementations while preserving the current timeline.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="fork-message">Branch Description</Label>
              <Input
                id="fork-message"
                placeholder="Describe this branch (e.g., 'Try alternative UI approach')"
                value={forkMessage}
                onChange={(e) => setForkMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && forkMessage.trim()) {
                    handleForkCheckpoint();
                  }
                }}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowForkDialog(false);
                setForkMessage("");
                setSelectedCheckpoint(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleForkCheckpoint}
              disabled={!forkMessage.trim() || isRestoring}
            >
              {isRestoring ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <GitBranchPlus className="h-4 w-4 mr-2" />
              )}
              Create Branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Diff Viewer Dialog */}
      <Dialog open={showDiffDialog} onOpenChange={(open) => {
        setShowDiffDialog(open);
        if (!open) {
          setDiffData(null);
          setDiffFromCheckpoint(null);
          setDiffToCheckpoint(null);
        }
      }}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompare className="h-5 w-5" />
              Checkpoint Changes
            </DialogTitle>
            <DialogDescription>
              {diffFromCheckpoint && diffToCheckpoint && (
                <span className="font-mono text-xs">
                  {diffFromCheckpoint.substring(0, 8)} → {diffToCheckpoint.substring(0, 8)}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-hidden">
            {diffLoading ? (
              <div className="flex items-center justify-center h-96">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : diffData ? (
              <DiffViewer
                diff={diffData}
                maxHeight="calc(90vh - 200px)"
              />
            ) : (
              <div className="flex items-center justify-center h-96 text-muted-foreground">
                No diff data available
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}; 