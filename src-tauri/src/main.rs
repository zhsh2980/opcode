// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude_binary;
mod commands;
mod process;
mod checkpoint;

use commands::agents::{
    cleanup_finished_processes, create_agent, delete_agent, execute_agent, export_agent,
    export_agent_to_file, fetch_github_agent_content, fetch_github_agents, get_agent,
    get_agent_run, get_agent_run_with_real_time_metrics, get_claude_binary_path,
    get_live_session_output, get_session_output, get_session_status, import_agent,
    import_agent_from_file, import_agent_from_github, init_database, kill_agent_session,
    list_agent_runs, list_agent_runs_with_metrics, list_agents, list_claude_installations,
    list_running_sessions, load_agent_session_history, set_claude_binary_path, stream_session_output, update_agent, AgentDb,
};
use commands::claude::{
    cancel_claude_execution, check_claude_version,
    continue_claude_code, execute_claude_code,
    find_claude_md_files, get_claude_session_output, get_claude_settings, get_project_sessions,
    get_system_prompt, list_directory_contents, list_projects, list_running_claude_sessions, load_session_history,
    open_new_session, read_claude_md_file,
    resume_claude_code,
    save_claude_md_file, save_claude_settings, save_system_prompt, search_files,
    get_hooks_config, update_hooks_config, validate_hook_command,
    ClaudeProcessState,
};
use commands::mcp::{
    mcp_add, mcp_add_from_claude_desktop, mcp_add_json, mcp_get, mcp_get_server_status, mcp_list,
    mcp_read_project_config, mcp_remove, mcp_reset_project_choices, mcp_save_project_config,
    mcp_serve, mcp_test_connection,
};

use commands::usage::{
    get_session_stats, get_usage_by_date_range, get_usage_details, get_usage_stats,
};
use commands::storage::{
    storage_list_tables, storage_read_table, storage_update_row, storage_delete_row,
    storage_insert_row, storage_execute_sql, storage_reset_database,
};
use checkpoint::commands::{
    titor_init_session, titor_checkpoint_message, titor_get_timeline, titor_list_checkpoints,
    titor_restore_checkpoint, titor_fork_checkpoint, titor_get_checkpoint_at_message,
    titor_verify_checkpoint, titor_diff_checkpoints, titor_diff_checkpoints_detailed, titor_gc,
    titor_list_all_checkpoints,
    CheckpointState,
};
use process::ProcessRegistryState;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    // Initialize logger
    env_logger::init();


    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize agents database
            let conn = init_database(&app.handle()).expect("Failed to initialize agents database");
            app.manage(AgentDb(Mutex::new(conn)));

            // Initialize process registry
            app.manage(ProcessRegistryState::default());

            // Initialize Claude process state
            app.manage(ClaudeProcessState::default());

            // Initialize checkpoint state
            app.manage(CheckpointState::new());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Claude & Project Management
            list_projects,
            get_project_sessions,
            get_claude_settings,
            open_new_session,
            get_system_prompt,
            check_claude_version,
            save_system_prompt,
            save_claude_settings,
            find_claude_md_files,
            read_claude_md_file,
            save_claude_md_file,
            load_session_history,
            execute_claude_code,
            continue_claude_code,
            resume_claude_code,
            cancel_claude_execution,
            list_running_claude_sessions,
            get_claude_session_output,
            list_directory_contents,
            search_files,
            get_hooks_config,
            update_hooks_config,
            validate_hook_command,
            
            // Agent Management
            list_agents,
            create_agent,
            update_agent,
            delete_agent,
            get_agent,
            execute_agent,
            list_agent_runs,
            get_agent_run,
            list_agent_runs_with_metrics,
            get_agent_run_with_real_time_metrics,
            list_running_sessions,
            kill_agent_session,
            get_session_status,
            cleanup_finished_processes,
            get_session_output,
            get_live_session_output,
            stream_session_output,
            load_agent_session_history,
            get_claude_binary_path,
            set_claude_binary_path,
            list_claude_installations,
            export_agent,
            export_agent_to_file,
            import_agent,
            import_agent_from_file,
            fetch_github_agents,
            fetch_github_agent_content,
            import_agent_from_github,
            
            // Usage & Analytics
            get_usage_stats,
            get_usage_by_date_range,
            get_usage_details,
            get_session_stats,
            
            // MCP (Model Context Protocol)
            mcp_add,
            mcp_list,
            mcp_get,
            mcp_remove,
            mcp_add_json,
            mcp_add_from_claude_desktop,
            mcp_serve,
            mcp_test_connection,
            mcp_reset_project_choices,
            mcp_get_server_status,
            mcp_read_project_config,
            mcp_save_project_config,
            
            // Storage Management
            storage_list_tables,
            storage_read_table,
            storage_update_row,
            storage_delete_row,
            storage_insert_row,
            storage_execute_sql,
            storage_reset_database,
            
            // Slash Commands
            commands::slash_commands::slash_commands_list,
            commands::slash_commands::slash_command_get,
            commands::slash_commands::slash_command_save,
            commands::slash_commands::slash_command_delete,
            
            // Titor Checkpoint Management
            titor_init_session,
            titor_checkpoint_message,
            titor_get_timeline,
            titor_list_checkpoints,
            titor_restore_checkpoint,
            titor_fork_checkpoint,
            titor_get_checkpoint_at_message,
            titor_verify_checkpoint,
            titor_diff_checkpoints,
            titor_diff_checkpoints_detailed,
            titor_gc,
            titor_list_all_checkpoints,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
