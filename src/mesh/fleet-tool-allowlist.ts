/**
 * The tools a herder node answers for its fleet peers over the direct
 * transport. The legacy wire names (mesh_stop, mesh_rename_session,
 * fleet_session_view) are gone: the fleet speaks the same canonical
 * commands the catalog advertises (stop_agent, rename_session, agent_info),
 * so no legacy alias stays registered anywhere.
 */
export const FLEET_DIRECT_TOOLS: readonly string[] = [
  "list_active_sessions_local", "model_quotas", "fleet_node_info", "mesh_snapshot",
  "create_session", "fleet_session_page", "agent_info", "session_search_local",
  "list_agents", "export_transcript", "send_message", "mesh_deliver", "stop_agent", "rename_session",
  "workspace_probe", "workspace_reserve", "workspace_owners", "automation_disarm",
  "common_settings_read", "common_settings_status", "common_settings_notice",
  "common_settings_opt_in", "common_settings_restore", "session_queue_processing_get",
  "session_queue_processing_resume", "job_get",
];
