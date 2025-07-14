/**
 * DiffViewer component for displaying line-level code diffs
 * Shows added, deleted, and context lines with appropriate styling
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  FilePlus, 
  FileMinus, 
  FileEdit, 
  ChevronDown, 
  ChevronRight,
  FileCode,
  Copy,
  Check,
  Eye,
  EyeOff,
  Filter
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { DetailedDiffResponse, FileDiffResponse, HunkResponse, LineChangeResponse } from "../lib/api";

interface DiffViewerProps {
  /** The detailed diff data from the API */
  diff: DetailedDiffResponse;
  /** Optional title for the diff viewer */
  title?: string;
  /** Optional description */
  description?: string;
  /** Class name for styling */
  className?: string;
  /** Whether to show context lines (default: true) */
  showContext?: boolean;
  /** Whether to show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Maximum height for the viewer */
  maxHeight?: string;
}

/**
 * Line component for rendering individual diff lines
 */
const DiffLine: React.FC<{
  change: LineChangeResponse;
  showLineNumbers: boolean;
}> = ({ change, showLineNumbers }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(change.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lineClass = cn(
    "font-mono text-xs group hover:bg-opacity-50 transition-colors",
    change.changeType === "added" && "bg-green-50 dark:bg-green-950/30 text-green-900 dark:text-green-100",
    change.changeType === "deleted" && "bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-100",
    change.changeType === "context" && "text-muted-foreground hover:bg-muted/30"
  );

  const lineSymbol = change.changeType === "added" ? "+" : change.changeType === "deleted" ? "-" : " ";

  return (
    <div className={cn("flex items-start pr-4", lineClass)}>
      {showLineNumbers && (
        <span className="inline-block w-12 text-right pr-2 select-none text-muted-foreground/60">
          {change.lineNumber}
        </span>
      )}
      <span className={cn(
        "inline-block w-6 text-center select-none font-bold",
        change.changeType === "added" && "text-green-600 dark:text-green-400",
        change.changeType === "deleted" && "text-red-600 dark:text-red-400",
        change.changeType === "context" && "text-muted-foreground/40"
      )}>
        {lineSymbol}
      </span>
      <pre className="flex-1 overflow-x-auto whitespace-pre">
        <code>{change.content}</code>
      </pre>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ml-2"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy line</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

/**
 * Hunk component for rendering a group of related changes
 */
const DiffHunk: React.FC<{
  hunk: HunkResponse;
  showContext: boolean;
  showLineNumbers: boolean;
}> = ({ hunk, showContext, showLineNumbers }) => {
  const visibleChanges = showContext 
    ? hunk.changes 
    : hunk.changes.filter(c => c.changeType !== "context");

  return (
    <div className="mb-4">
      {/* Hunk header */}
      <div className="bg-muted/50 px-4 py-1 text-xs font-mono text-muted-foreground border-y">
        @@ -{hunk.fromLine},{hunk.fromCount} +{hunk.toLine},{hunk.toCount} @@
      </div>
      
      {/* Lines */}
      <div className="border-b">
        {visibleChanges.map((change, idx) => (
          <DiffLine 
            key={idx} 
            change={change} 
            showLineNumbers={showLineNumbers}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * File diff component for rendering changes to a single file
 */
const FileDiff: React.FC<{
  fileDiff: FileDiffResponse;
  isExpanded: boolean;
  onToggle: () => void;
  showContext: boolean;
  showLineNumbers: boolean;
}> = ({ fileDiff, isExpanded, onToggle, showContext, showLineNumbers }) => {
  // Calculate stats
  const additions = fileDiff.hunks.reduce(
    (sum, hunk) => sum + hunk.changes.filter(c => c.changeType === "added").length,
    0
  );
  const deletions = fileDiff.hunks.reduce(
    (sum, hunk) => sum + hunk.changes.filter(c => c.changeType === "deleted").length,
    0
  );

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader className="py-3 cursor-pointer hover:bg-muted/30 transition-colors" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-sm">{fileDiff.path}</span>
            {fileDiff.isBinary && (
              <Badge variant="secondary" className="text-xs">Binary</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {additions > 0 && (
              <span className="text-xs text-green-600 dark:text-green-400">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-xs text-red-600 dark:text-red-400">
                -{deletions}
              </span>
            )}
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CardHeader>
      
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <CardContent className="p-0">
              {fileDiff.isBinary ? (
                <div className="p-4 text-sm text-muted-foreground text-center">
                  Binary file changed
                </div>
              ) : (
                <ScrollArea className="w-full">
                  <div className="min-w-max">
                    {fileDiff.hunks.map((hunk, idx) => (
                      <DiffHunk
                        key={idx}
                        hunk={hunk}
                        showContext={showContext}
                        showLineNumbers={showLineNumbers}
                      />
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
};

/**
 * Main DiffViewer component
 */
export const DiffViewer: React.FC<DiffViewerProps> = ({
  diff,
  title,
  description,
  className,
  showContext = true,
  showLineNumbers = true,
  maxHeight = "600px",
}) => {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [localShowContext, setLocalShowContext] = useState(showContext);
  const [localShowLineNumbers, setLocalShowLineNumbers] = useState(showLineNumbers);
  const [filterMode, setFilterMode] = useState<"all" | "added" | "modified" | "deleted">("all");

  // Toggle file expansion
  const toggleFile = (path: string) => {
    setExpandedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  // Expand/collapse all
  const expandAll = () => {
    setExpandedFiles(new Set(diff.fileDiffs.map(fd => fd.path)));
  };

  const collapseAll = () => {
    setExpandedFiles(new Set());
  };

  // Filter files based on mode
  const filteredDiffs = diff.fileDiffs.filter(fileDiff => {
    if (filterMode === "all") return true;
    
    // Check if file appears in the corresponding basic diff arrays
    const path = fileDiff.path;
    
    if (filterMode === "added") {
      return diff.basicDiff.addedFiles.some((f: any) => 
        (typeof f === 'string' ? f : f.path) === path
      );
    }
    
    if (filterMode === "modified") {
      return diff.basicDiff.modifiedFiles.some((f: any) => {
        if (f.old && f.new) {
          return f.new.path === path || f.old.path === path;
        }
        return (typeof f === 'string' ? f : f.path) === path;
      });
    }
    
    if (filterMode === "deleted") {
      return diff.basicDiff.deletedFiles.some((f: any) => 
        (typeof f === 'string' ? f : f.path) === path
      );
    }
    
    return false;
  });

  return (
    <div className={cn("space-y-4", className)}>
      {/* Header */}
      {(title || description) && (
        <div className="space-y-1">
          {title && <h3 className="text-lg font-semibold">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}

      {/* Summary stats */}
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <FilePlus className="h-4 w-4 text-green-600 dark:text-green-400" />
          <span>{diff.basicDiff.addedFiles.length} added</span>
        </div>
        <div className="flex items-center gap-2">
          <FileEdit className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <span>{diff.basicDiff.modifiedFiles.length} modified</span>
        </div>
        <div className="flex items-center gap-2">
          <FileMinus className="h-4 w-4 text-red-600 dark:text-red-400" />
          <span>{diff.basicDiff.deletedFiles.length} deleted</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">
            +{diff.totalLinesAdded}
          </span>
          <span className="text-red-600 dark:text-red-400">
            -{diff.totalLinesDeleted}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between border rounded-lg p-3 bg-muted/30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="show-context"
              checked={localShowContext}
              onCheckedChange={setLocalShowContext}
            />
            <Label htmlFor="show-context" className="text-sm">
              Context lines
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="show-line-numbers"
              checked={localShowLineNumbers}
              onCheckedChange={setLocalShowLineNumbers}
            />
            <Label htmlFor="show-line-numbers" className="text-sm">
              Line numbers
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={filterMode}
              onValueChange={(value) => setFilterMode(value as "all" | "added" | "modified" | "deleted")}
            >
              <SelectTrigger className="w-[140px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All files</SelectItem>
                <SelectItem value="added">Added only</SelectItem>
                <SelectItem value="modified">Modified only</SelectItem>
                <SelectItem value="deleted">Deleted only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={expandAll}>
            <Eye className="h-3 w-3 mr-1" />
            Expand all
          </Button>
          <Button size="sm" variant="outline" onClick={collapseAll}>
            <EyeOff className="h-3 w-3 mr-1" />
            Collapse all
          </Button>
        </div>
      </div>

      {/* File diffs */}
      <ScrollArea style={{ maxHeight }} className="pr-4">
        {filteredDiffs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No files match the current filter
          </div>
        ) : (
          filteredDiffs.map((fileDiff) => (
            <FileDiff
              key={fileDiff.path}
              fileDiff={fileDiff}
              isExpanded={expandedFiles.has(fileDiff.path)}
              onToggle={() => toggleFile(fileDiff.path)}
              showContext={localShowContext}
              showLineNumbers={localShowLineNumbers}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}; 